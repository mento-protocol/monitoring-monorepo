"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type Network,
} from "@/lib/networks";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { ORACLE_RATES, PROTOCOL_FEE_TRANSFERS_ALL } from "@/lib/queries";
import {
  buildSnapshotWindows,
  SNAPSHOT_REFRESH_MS,
  type SnapshotWindows,
} from "@/lib/volume";
import { buildOracleRateMap, type OracleRateMap } from "@/lib/tokens";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Pool, ProtocolFeeTransfer } from "@/lib/types";

type OracleRatesPool = Pick<
  Pool,
  "token0" | "token1" | "oraclePrice" | "oracleOk"
>;

type ProtocolFeesResult = {
  /**
   * `NetworkData[]`-shaped payload so revenue/page.tsx and FeeOverTimeChart
   * keep their existing types. Only the fee/rate slices are populated —
   * `pools`, `snapshots`, `tradingLimits`, `uniqueLpAddresses`, etc. are
   * zero defaults. The chart only reads `feeTransfers`, `rates`, and
   * `snapshotWindows`; the revenue page reads `error`, `feesError`, `fees`,
   * `feeTransfers`. Anything else stays empty.
   */
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

function emptyFeesNetworkData(
  network: Network,
  windows: SnapshotWindows,
  error: Error,
): NetworkData {
  return {
    network,
    snapshotWindows: windows,
    pools: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAllDaily: [],
    snapshotsAllDailyTruncated: false,
    tradingLimits: [],
    olsPoolIds: new Set(),
    fees: null,
    feeTransfers: [],
    uniqueLpAddresses: null,
    rates: new Map(),
    error,
    feesError: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    lpError: null,
  };
}

async function fetchFeesForNetwork(
  network: Network,
  windows: SnapshotWindows,
): Promise<NetworkData> {
  if (!network.hasuraUrl) {
    return emptyFeesNetworkData(
      network,
      windows,
      new Error(`Hasura URL not configured for "${network.label}"`),
    );
  }
  const client = new GraphQLClient(network.hasuraUrl);

  // Fetch rates + fees in parallel per chain — both needed to aggregate
  // protocol fees in USD. `allSettled` so a rates failure doesn't blank
  // fees and vice versa.
  const [ratesResult, feesResult] = await Promise.allSettled([
    client.request<{ Pool: OracleRatesPool[] }>(ORACLE_RATES, {
      chainId: network.chainId,
    }),
    client.request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
      PROTOCOL_FEE_TRANSFERS_ALL,
      { chainId: network.chainId },
    ),
  ]);

  const rates =
    ratesResult.status === "fulfilled"
      ? buildOracleRateMap(ratesResult.value.Pool ?? [], network)
      : new Map<string, number>();

  const feeTransfers =
    feesResult.status === "fulfilled"
      ? (feesResult.value.ProtocolFeeTransfer ?? [])
      : [];
  const fees: ProtocolFeeSummary | null =
    feesResult.status === "fulfilled"
      ? aggregateProtocolFees(feeTransfers, rates)
      : null;
  const toError = (reason: unknown) =>
    reason instanceof Error ? reason : new Error(String(reason));
  const feesError =
    feesResult.status === "rejected" ? toError(feesResult.reason) : null;

  return {
    network,
    snapshotWindows: windows,
    pools: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAllDaily: [],
    snapshotsAllDailyTruncated: false,
    tradingLimits: [],
    olsPoolIds: new Set(),
    fees,
    feeTransfers,
    uniqueLpAddresses: null,
    rates,
    error: null,
    feesError,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    lpError: null,
  };
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
      : emptyFeesNetworkData(
          NETWORKS[ids[i]],
          windows,
          r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
        ),
  );
}

/**
 * Lightweight protocol-fees hook. Fetches only the fees + rate data needed
 * by /revenue — instead of `useAllNetworksData` which additionally pulls
 * paginated daily snapshots, trading limits, OLS pools, LP addresses, and
 * the breach rollup. Saves ~6 queries per chain per mount.
 *
 * Returns a `NetworkData[]` shape so downstream consumers (revenue/page.tsx,
 * FeeOverTimeChart) don't need to change. Unused fields are zero defaults.
 */
export function useProtocolFees(): ProtocolFeesResult {
  const { data, error, isLoading } = useSWR<NetworkData[]>(
    "protocol-fees-all-networks",
    fetchAllProtocolFees,
    {
      refreshInterval: SNAPSHOT_REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );

  return {
    networkData: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
  };
}

// Re-export so consumers can still discriminate types if needed.
export type { OracleRateMap };
