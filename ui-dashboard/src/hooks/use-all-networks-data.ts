"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import type { Network } from "@/lib/networks";
import {
  ALL_POOLS_WITH_HEALTH,
  POOL_SNAPSHOT_QUERY_LIMIT,
  POOL_SNAPSHOTS_ALL,
  POOL_SNAPSHOTS_WINDOW,
  PROTOCOL_FEE_TRANSFERS_ALL,
  UNIQUE_LP_ADDRESSES,
} from "@/lib/queries";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import {
  buildSnapshotWindows,
  shouldQueryPoolSnapshots,
  SNAPSHOT_REFRESH_MS,
  type SnapshotWindows,
  type TimeRange,
} from "@/lib/volume";
import type {
  Pool,
  PoolSnapshotWindow,
  ProtocolFeeTransfer,
} from "@/lib/types";
import { isFpmm, buildOracleRateMap, type OracleRateMap } from "@/lib/tokens";

export type NetworkData = {
  network: Network;
  snapshotWindows: SnapshotWindows;
  pools: Pool[];
  snapshots: PoolSnapshotWindow[];
  snapshots7d: PoolSnapshotWindow[];
  snapshots30d: PoolSnapshotWindow[];
  /** All-time snapshots (unbounded) — used by chart series with the "All" range. */
  snapshotsAll: PoolSnapshotWindow[];
  /**
   * True when the all-history query hit the server-side row limit and older
   * rows were dropped. Consumers should treat the series as partial when this
   * is set — same UX as a snapshot-query failure.
   */
  snapshotsAllTruncated: boolean;
  fees: ProtocolFeeSummary | null;
  uniqueLpCount: number | null;
  rates: OracleRateMap;
  error: Error | null;
  feesError: Error | null;
  snapshotsError: Error | null;
  snapshots7dError: Error | null;
  snapshots30dError: Error | null;
  snapshotsAllError: Error | null;
  lpError: Error | null;
};

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

const emptyNetworkData = (
  network: Network,
  snapshotWindows: SnapshotWindows,
  error: Error,
): NetworkData => ({
  network,
  snapshotWindows,
  pools: [],
  snapshots: [],
  snapshots7d: [],
  snapshots30d: [],
  snapshotsAll: [],
  snapshotsAllTruncated: false,
  fees: null,
  uniqueLpCount: null,
  rates: new Map(),
  error,
  feesError: null,
  snapshotsError: null,
  snapshots7dError: null,
  snapshots30dError: null,
  snapshotsAllError: null,
  lpError: null,
});

/** @internal Exported for testing only. */
export async function fetchNetworkData(
  network: Network,
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange },
): Promise<NetworkData> {
  const secret = network.hasuraSecret.trim();
  const client = new GraphQLClient(network.hasuraUrl, {
    headers: secret ? { "x-hasura-admin-secret": secret } : {},
  });

  let pools: Pool[];
  try {
    const poolsRes = await client.request<{ Pool: Pool[] }>(
      ALL_POOLS_WITH_HEALTH,
      { chainId: network.chainId },
    );
    pools = poolsRes.Pool ?? [];
  } catch (err) {
    return emptyNetworkData(
      network,
      windows,
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  const poolIds = pools.map((p) => p.id);
  const fpmmPoolIds = pools.filter(isFpmm).map((p) => p.id);
  const shouldQuery = shouldQueryPoolSnapshots(poolIds);
  const emptySnapshots = Promise.resolve<{
    PoolSnapshot: PoolSnapshotWindow[];
  }>({ PoolSnapshot: [] });

  const [
    feesResult,
    snapshotsResult,
    snapshots7dResult,
    snapshots30dResult,
    snapshotsAllResult,
    lpResult,
  ] = await Promise.allSettled([
    client.request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
      PROTOCOL_FEE_TRANSFERS_ALL,
      { chainId: network.chainId },
    ),
    shouldQuery
      ? client.request<{ PoolSnapshot: PoolSnapshotWindow[] }>(
          POOL_SNAPSHOTS_WINDOW,
          { from: windows.w24h.from, to: windows.w24h.to, poolIds },
        )
      : emptySnapshots,
    shouldQuery
      ? client.request<{ PoolSnapshot: PoolSnapshotWindow[] }>(
          POOL_SNAPSHOTS_WINDOW,
          { from: windows.w7d.from, to: windows.w7d.to, poolIds },
        )
      : emptySnapshots,
    shouldQuery
      ? client.request<{ PoolSnapshot: PoolSnapshotWindow[] }>(
          POOL_SNAPSHOTS_WINDOW,
          { from: windows.w30d.from, to: windows.w30d.to, poolIds },
        )
      : emptySnapshots,
    shouldQuery
      ? client.request<{ PoolSnapshot: PoolSnapshotWindow[] }>(
          POOL_SNAPSHOTS_ALL,
          { poolIds },
        )
      : emptySnapshots,
    fpmmPoolIds.length > 0
      ? client.request<{
          LiquidityPosition: { address: string }[];
        }>(UNIQUE_LP_ADDRESSES, { poolIds: fpmmPoolIds })
      : Promise.resolve({
          LiquidityPosition: [] as { address: string }[],
        }),
  ]);

  const toError = (reason: unknown) =>
    reason instanceof Error ? reason : new Error(String(reason));

  const rates = buildOracleRateMap(pools, network);

  const fees =
    feesResult.status === "fulfilled"
      ? aggregateProtocolFees(feesResult.value.ProtocolFeeTransfer ?? [], rates)
      : null;

  const snapshots =
    snapshotsResult.status === "fulfilled"
      ? (snapshotsResult.value.PoolSnapshot ?? [])
      : [];
  const snapshots7d =
    snapshots7dResult.status === "fulfilled"
      ? (snapshots7dResult.value.PoolSnapshot ?? [])
      : [];
  const snapshots30d =
    snapshots30dResult.status === "fulfilled"
      ? (snapshots30dResult.value.PoolSnapshot ?? [])
      : [];
  const snapshotsAll =
    snapshotsAllResult.status === "fulfilled"
      ? (snapshotsAllResult.value.PoolSnapshot ?? [])
      : [];
  const snapshotsAllTruncated =
    snapshotsAll.length >= POOL_SNAPSHOT_QUERY_LIMIT;

  const uniqueLpCount =
    lpResult.status === "fulfilled"
      ? new Set(
          (lpResult.value.LiquidityPosition ?? []).map((lp) => lp.address),
        ).size
      : null;

  return {
    network,
    snapshotWindows: windows,
    pools,
    snapshots,
    snapshots7d,
    snapshots30d,
    snapshotsAll,
    snapshotsAllTruncated,
    fees,
    uniqueLpCount,
    rates,
    error: null,
    feesError:
      feesResult.status === "rejected" ? toError(feesResult.reason) : null,
    snapshotsError:
      snapshotsResult.status === "rejected"
        ? toError(snapshotsResult.reason)
        : null,
    snapshots7dError:
      snapshots7dResult.status === "rejected"
        ? toError(snapshots7dResult.reason)
        : null,
    snapshots30dError:
      snapshots30dResult.status === "rejected"
        ? toError(snapshots30dResult.reason)
        : null,
    snapshotsAllError:
      snapshotsAllResult.status === "rejected"
        ? toError(snapshotsAllResult.reason)
        : null,
    lpError: lpResult.status === "rejected" ? toError(lpResult.reason) : null,
  };
}

/** @internal Exported for testing only. */
export async function fetchAllNetworks(): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const now = Date.now();
  const windows = buildSnapshotWindows(now);

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) => fetchNetworkData(NETWORKS[id], windows)),
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return emptyNetworkData(
      NETWORKS[configuredNetworkIds[i]],
      windows,
      result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason)),
    );
  });
}

/**
 * Fetches pools, snapshots (24h/7d/30d), protocol fees, and LP counts for ALL
 * configured networks in parallel. Uses Promise.allSettled so one failing network
 * doesn't block others. Sub-query failures are surfaced as per-field errors so
 * the UI can show "N/A" instead of silently reporting $0 or zero volume.
 */
export function useAllNetworksData(): AllNetworksResult {
  const { data, error, isLoading } = useSWR<NetworkData[]>(
    "all-networks-data",
    fetchAllNetworks,
    { refreshInterval: SNAPSHOT_REFRESH_MS },
  );

  return {
    networkData: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
