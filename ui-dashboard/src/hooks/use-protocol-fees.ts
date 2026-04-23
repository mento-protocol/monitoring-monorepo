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
import { ORACLE_RATES, PROTOCOL_FEE_TRANSFERS_ALL } from "@/lib/queries";
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
import { blankNetworkData, type NetworkData } from "@/lib/fetch-all-networks";
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
   */
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
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

  // Fetch rates + fees in parallel per chain — both needed to aggregate
  // protocol fees in USD. `allSettled` so a rates failure doesn't blank
  // fees and vice versa.
  const [ratesResult, feesResult] = await Promise.allSettled([
    client.request<{ Pool: OracleRatePool[] }>(ORACLE_RATES, {
      chainId: network.chainId,
    }),
    client.request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
      PROTOCOL_FEE_TRANSFERS_ALL,
      { chainId: network.chainId },
    ),
  ]);

  const rates: OracleRateMap =
    ratesResult.status === "fulfilled"
      ? buildOracleRateMap(ratesResult.value.Pool ?? [], network)
      : new Map();

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

  return blankNetworkData(network, windows, {
    rates,
    fees,
    feeTransfers,
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
  const { data, error, isLoading } = useSWR<NetworkData[]>(
    SWR_KEY_PROTOCOL_FEES,
    fetchAllProtocolFees,
    SHARED_QUERY_SWR_CONFIG,
  );

  return {
    networkData: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
  };
}

// Re-export so consumers can still discriminate types if needed.
export type { OracleRateMap };
