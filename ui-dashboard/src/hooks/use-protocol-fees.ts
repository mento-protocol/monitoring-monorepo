"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type Network,
} from "@/lib/networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { ORACLE_RATES, POOL_LABELS_ALL } from "@/lib/queries";
import { buildSnapshotWindows, type SnapshotWindows } from "@/lib/volume";
import {
  buildOracleRateMap,
  type OracleRateMap,
  type OracleRatePool,
} from "@/lib/tokens";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import {
  blankNetworkData,
  fetchAllFeeSnapshotPages,
  REQUEST_TIMEOUT_MS,
  type NetworkData,
  type PoolLabel,
} from "@/lib/fetch-all-networks";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import { SWR_KEY_PROTOCOL_FEES } from "@/lib/swr-keys";

type ProtocolFeesResult = {
  /**
   * `NetworkData[]`-shaped payload so the revenue page's chart and per-pool
   * table keep their existing types. Only the fees / rate / labels slices
   * are populated — `pools`, `snapshots`,
   * `tradingLimits`, `uniqueLpAddresses`, etc. stay at `blankNetworkData`'s
   * zero defaults.
   *
   * Chain-level transport failures surface through `networkData[].error`,
   * not a top-level error — `fetchAllProtocolFees` always resolves.
   */
  networkData: NetworkData[];
  isLoading: boolean;
};

async function fetchFeesForNetwork(
  network: Network,
  windows: SnapshotWindows,
): Promise<NetworkData> {
  if (!network.hasuraUrl) {
    return blankNetworkData(network, windows, {
      error: new Error(`Hasura URL not configured for "${network.label}"`),
    });
  }
  const client = new GraphQLClient(network.hasuraUrl);

  // `allSettled` so any single failure doesn't blank the others. A labels-only
  // failure is non-fatal — the table falls back to truncated-address
  // labels, so it stays out of the error channels.
  const [ratesResult, labelsResult, snapshotsResult] = await Promise.allSettled(
    [
      client.request<{ Pool: OracleRatePool[] }>({
        document: ORACLE_RATES,
        variables: { chainId: network.chainId },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      client.request<{ Pool: PoolLabel[] }>({
        document: POOL_LABELS_ALL,
        variables: { chainId: network.chainId },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      // Pool×day-bounded snapshot rollup; paginated in the helper because
      // hosted Hasura silently caps at 1000 rows. Mid-page failures fail
      // open (return what we fetched + flag error inside the result), so
      // the helper itself never rejects from a partial outage — the only
      // path to rejection is a first-page failure or a network/abort error.
      fetchAllFeeSnapshotPages(client, network.chainId, network.id),
    ],
  );

  const rates: OracleRateMap =
    ratesResult.status === "fulfilled"
      ? buildOracleRateMap(ratesResult.value.Pool ?? [], network)
      : new Map();

  const poolLabels = new Map<string, PoolLabel>();
  if (labelsResult.status === "fulfilled") {
    for (const p of labelsResult.value.Pool ?? []) {
      poolLabels.set(stripChainIdFromPoolId(p.id).toLowerCase(), p);
    }
  }
  const toError = (reason: unknown) =>
    reason instanceof Error ? reason : new Error(String(reason));

  // Two independent error channels so each consumer fails closed only on
  // the sub-failure that genuinely affects it:
  //
  //   ratesError        — oracle rates query rejected. Empty rate map ⇒
  //                       FX-token slots silently mis-price. Affects ALL
  //                       USD aggregation: tile, chart, AND table.
  //   feeSnapshotsError — `PoolDailyFeeSnapshot` paginated fetch rejected
  //                       OR surfaced a mid-pagination error. Affects all
  //                       three consumers — fees come from snapshots now.
  //
  // (Pre-PR-snapshot-3 there was a third `feesError` channel for the
  // raw-transfer query; that query is gone, so the channel is gone too.)
  const ratesError =
    ratesResult.status === "rejected" ? toError(ratesResult.reason) : null;
  const feeSnapshotsError =
    snapshotsResult.status === "rejected"
      ? toError(snapshotsResult.reason)
      : (snapshotsResult.value.error ?? null);
  // Cap-exhaustion path: helper returns `truncated: true, error: null` when
  // it hit `SNAPSHOT_MAX_PAGES` without running out of rows. We still
  // aggregate from the rows we did fetch; consumers (KPI tile, page-client)
  // OR this into `feesApprox` to surface the `≈` prefix + an
  // "Approximate — full history exceeds pagination cap" subtitle.
  const feeSnapshotsTruncated =
    snapshotsResult.status === "fulfilled" && snapshotsResult.value.truncated;
  const feeSnapshots =
    snapshotsResult.status === "fulfilled" ? snapshotsResult.value.rows : [];
  const fees: ProtocolFeeSummary | null =
    ratesResult.status === "fulfilled" &&
    snapshotsResult.status === "fulfilled" &&
    snapshotsResult.value.error === null
      ? aggregateProtocolFees(feeSnapshots, rates)
      : null;

  return blankNetworkData(network, windows, {
    rates,
    fees,
    feeSnapshots,
    feeSnapshotsError,
    feeSnapshotsTruncated,
    poolLabels,
    ratesError,
  });
}

async function fetchAllProtocolFees(): Promise<NetworkData[]> {
  const ids = NETWORK_IDS.filter(isConfiguredNetworkId);
  const windows = buildSnapshotWindows(Date.now());
  const results = await Promise.allSettled(
    ids.map((id) => fetchFeesForNetwork(NETWORKS[id], windows)),
  );
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : blankNetworkData(NETWORKS[ids[i]!], windows, {
          error:
            r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
        }),
  );
}

/**
 * Lightweight protocol-fees hook. Fetches only the data /revenue needs —
 * snapshot rollups (chain summary + chart + table), oracle rates,
 * and pool labels — instead of `useAllNetworksData` which also pulls
 * paginated daily volume snapshots, trading limits, OLS pools, LP
 * addresses, and the breach rollup. Saves ~6 queries per chain per mount.
 */
export function useProtocolFees(): ProtocolFeesResult {
  const { data, isLoading } = useSWR<NetworkData[]>(
    SWR_KEY_PROTOCOL_FEES,
    fetchAllProtocolFees,
    SHARED_QUERY_SWR_CONFIG,
  );

  return {
    networkData: data ?? [],
    isLoading,
  };
}
