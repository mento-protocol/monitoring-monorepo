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
import {
  ORACLE_RATES,
  POOL_LABELS_ALL,
  PROTOCOL_FEE_TRANSFERS_ALL,
} from "@/lib/queries";
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
  REQUEST_TIMEOUT_MS,
  type NetworkData,
  type PoolLabel,
} from "@/lib/fetch-all-networks";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import { SWR_KEY_PROTOCOL_FEES } from "@/lib/swr-keys";
import type { ProtocolFeeTransfer } from "@/lib/types";

type ProtocolFeesResult = {
  /**
   * `NetworkData[]`-shaped payload so revenue/page.tsx and FeeOverTimeChart
   * keep their existing types. Only the fee/rate slices are populated —
   * `pools`, `snapshots`, `tradingLimits`, `uniqueLpAddresses`, etc. stay at
   * `blankNetworkData`'s zero defaults. The chart only reads `feeTransfers`,
   * `rates`, and `snapshotWindows`; revenue/page.tsx reads `error`,
   * `feesError`, `fees`, `feeTransfers`.
   *
   * Chain-level failures surface through `networkData[].error`, not a
   * top-level error — `fetchAllProtocolFees` always resolves. That means
   * there's no `error` field on this result type.
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
  // failure is non-fatal — the leaderboard falls back to truncated-address
  // labels, so it stays out of `feesError`.
  const [ratesResult, feesResult, labelsResult] = await Promise.allSettled([
    client.request<{ Pool: OracleRatePool[] }>({
      document: ORACLE_RATES,
      variables: { chainId: network.chainId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    client.request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>({
      document: PROTOCOL_FEE_TRANSFERS_ALL,
      variables: { chainId: network.chainId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    client.request<{ Pool: PoolLabel[] }>({
      document: POOL_LABELS_ALL,
      variables: { chainId: network.chainId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  ]);

  const rates: OracleRateMap =
    ratesResult.status === "fulfilled"
      ? buildOracleRateMap(ratesResult.value.Pool ?? [], network)
      : new Map();

  const feeTransfers =
    feesResult.status === "fulfilled"
      ? (feesResult.value.ProtocolFeeTransfer ?? [])
      : [];

  const poolLabels = new Map<string, PoolLabel>();
  if (labelsResult.status === "fulfilled") {
    for (const p of labelsResult.value.Pool ?? []) {
      poolLabels.set(stripChainIdFromPoolId(p.id).toLowerCase(), p);
    }
  }
  const toError = (reason: unknown) =>
    reason instanceof Error ? reason : new Error(String(reason));

  // A rates-only failure would silently zero out every non-USD-pegged fee
  // transfer (aggregateProtocolFees calls tokenToUSD, which returns null
  // for unknown symbols and gets counted as "unresolved"). That understates
  // the chain's fees without any error signal to the consumer. Promote the
  // rates failure into `feesError` so the revenue page shows the partial-
  // data banner instead of a confidently-wrong lower bound.
  const feesError =
    feesResult.status === "rejected"
      ? toError(feesResult.reason)
      : ratesResult.status === "rejected"
        ? toError(ratesResult.reason)
        : null;
  const fees: ProtocolFeeSummary | null =
    feesResult.status === "fulfilled" && ratesResult.status === "fulfilled"
      ? aggregateProtocolFees(feeTransfers, rates)
      : null;

  return blankNetworkData(network, windows, {
    rates,
    fees,
    feeTransfers,
    poolLabels,
    feesError,
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
      : blankNetworkData(NETWORKS[ids[i]], windows, {
          error:
            r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
        }),
  );
}

/**
 * Lightweight protocol-fees hook. Fetches only the fees + rate data needed
 * by /revenue — instead of `useAllNetworksData` which additionally pulls
 * paginated daily snapshots, trading limits, OLS pools, LP addresses, and
 * the breach rollup. Saves ~6 queries per chain per mount.
 *
 * Returns a `NetworkData[]` shape so downstream consumers (revenue/page.tsx,
 * FeeOverTimeChart) don't need to change. Unused fields are zero defaults
 * from `blankNetworkData`.
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

// Re-export so consumers can still discriminate types if needed.
export type { OracleRateMap };
