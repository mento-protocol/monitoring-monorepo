"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import type { Network } from "@/lib/networks";
import {
  ALL_POOLS_WITH_HEALTH,
  POOL_SNAPSHOTS_WINDOW,
  PROTOCOL_FEE_TRANSFERS_ALL,
} from "@/lib/queries";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import {
  snapshotWindow24h,
  snapshotWindow7d,
  snapshotWindow30d,
  shouldQueryPoolSnapshots,
  SNAPSHOT_REFRESH_MS,
} from "@/lib/volume";
import type {
  Pool,
  PoolSnapshotWindow,
  ProtocolFeeTransfer,
} from "@/lib/types";

export type NetworkData = {
  network: Network;
  /** Non-empty only if the pools query itself succeeded. */
  pools: Pool[];
  /** Non-empty only when snapshotsError is null. */
  snapshots: PoolSnapshotWindow[];
  /** Non-empty only when snapshots7dError is null. */
  snapshots7d: PoolSnapshotWindow[];
  /** Non-empty only when snapshots30dError is null. */
  snapshots30d: PoolSnapshotWindow[];
  /** Non-null only when feesError is null. */
  fees: ProtocolFeeSummary | null;
  /** Set when the top-level pools query fails (whole network unusable). */
  error: Error | null;
  /** Set when the ProtocolFeeTransfer sub-query fails. Fees should show N/A. */
  feesError: Error | null;
  /** Set when the 24h PoolSnapshot sub-query fails. Volume/swaps should show N/A. */
  snapshotsError: Error | null;
  /** Set when the 7d PoolSnapshot sub-query fails. 7d volume should show N/A. */
  snapshots7dError: Error | null;
  /** Set when the 30d PoolSnapshot sub-query fails. 30d volume should show N/A. */
  snapshots30dError: Error | null;
};

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

export type TimeRange = { from: number; to: number };

function unpackSnapshots(
  result: PromiseSettledResult<{ PoolSnapshot: PoolSnapshotWindow[] }>,
): [PoolSnapshotWindow[], Error | null] {
  if (result.status === "fulfilled") {
    return [result.value.PoolSnapshot ?? [], null];
  }
  const error =
    result.reason instanceof Error
      ? result.reason
      : new Error(String(result.reason));
  return [[], error];
}

/** @internal Exported for testing only. */
export async function fetchNetworkData(
  network: Network,
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange },
): Promise<NetworkData> {
  // Trim whitespace — matches useGQL behaviour; Hasura treats whitespace-only
  // secrets as invalid auth and returns access-denied rather than falling
  // through to unauthenticated access.
  const secret = network.hasuraSecret.trim();
  const client = new GraphQLClient(network.hasuraUrl, {
    headers: secret ? { "x-hasura-admin-secret": secret } : {},
  });

  // Pools are required — if this fails, the whole network entry is an error.
  let pools: Pool[];
  try {
    const poolsRes = await client.request<{ Pool: Pool[] }>(
      ALL_POOLS_WITH_HEALTH,
      { chainId: network.chainId },
    );
    pools = poolsRes.Pool ?? [];
  } catch (err) {
    return {
      network,
      pools: [],
      snapshots: [],
      snapshots7d: [],
      snapshots30d: [],
      fees: null,
      error: err instanceof Error ? err : new Error(String(err)),
      feesError: null,
      snapshotsError: null,
      snapshots7dError: null,
      snapshots30dError: null,
    };
  }

  // Fees and snapshots are independent — run concurrently after pools succeeds.
  // Failures are surfaced per-field so the UI can show "N/A" rather than
  // silently reporting $0 or zero volume.
  const poolIds = pools.map((p) => p.id);
  const shouldQuery = shouldQueryPoolSnapshots(poolIds);
  const emptySnapshots = Promise.resolve<{
    PoolSnapshot: PoolSnapshotWindow[];
  }>({
    PoolSnapshot: [],
  });
  const [feesResult, snapshotsResult, snapshots7dResult, snapshots30dResult] =
    await Promise.allSettled([
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
    ]);

  const fees =
    feesResult.status === "fulfilled"
      ? aggregateProtocolFees(feesResult.value.ProtocolFeeTransfer ?? [])
      : null;
  const feesError =
    feesResult.status === "rejected"
      ? feesResult.reason instanceof Error
        ? feesResult.reason
        : new Error(String(feesResult.reason))
      : null;

  const [snapshots, snapshotsError] = unpackSnapshots(snapshotsResult);
  const [snapshots7d, snapshots7dError] = unpackSnapshots(snapshots7dResult);
  const [snapshots30d, snapshots30dError] = unpackSnapshots(snapshots30dResult);

  return {
    network,
    pools,
    snapshots,
    snapshots7d,
    snapshots30d,
    fees,
    error: null,
    feesError,
    snapshotsError,
    snapshots7dError,
    snapshots30dError,
  };
}

/** @internal Exported for testing only. */
export async function fetchAllNetworks(): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const now = Date.now();
  const windows = {
    w24h: snapshotWindow24h(now),
    w7d: snapshotWindow7d(now),
    w30d: snapshotWindow30d(now),
  };

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) => fetchNetworkData(NETWORKS[id], windows)),
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return {
      network: NETWORKS[configuredNetworkIds[i]],
      pools: [],
      snapshots: [],
      snapshots7d: [],
      snapshots30d: [],
      fees: null,
      error:
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason)),
      feesError: null,
      snapshotsError: null,
      snapshots7dError: null,
      snapshots30dError: null,
    };
  });
}

/**
 * Fetches pools, 24h snapshots, and protocol fees for ALL configured networks
 * in parallel. Uses Promise.allSettled so one failing network doesn't block
 * others. Sub-query failures (fees, snapshots) are surfaced as per-field errors
 * so the UI can show "N/A" instead of silently reporting $0 or zero volume.
 * Ignores the global network selector — always fetches all chains.
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
