"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import type { Network } from "@/lib/networks";
import {
  ALL_POOLS_WITH_HEALTH,
  POOL_SNAPSHOTS_24H,
  PROTOCOL_FEE_TRANSFERS_ALL,
} from "@/lib/queries";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import { snapshotWindow24h, shouldQueryPoolSnapshots24h } from "@/lib/volume";
import type { Pool, PoolSnapshot24h, ProtocolFeeTransfer } from "@/lib/types";

export type NetworkData = {
  network: Network;
  /** Non-empty only if the pools query itself succeeded. */
  pools: Pool[];
  /** Non-empty only when snapshotsError is null. */
  snapshots: PoolSnapshot24h[];
  /** Non-null only when feesError is null. */
  fees: ProtocolFeeSummary | null;
  /** Set when the top-level pools query fails (whole network unusable). */
  error: Error | null;
  /** Set when the ProtocolFeeTransfer sub-query fails. Fees should show N/A. */
  feesError: Error | null;
  /** Set when the PoolSnapshot sub-query fails. Volume/swaps should show N/A. */
  snapshotsError: Error | null;
};

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

/** @internal Exported for testing only. */
export async function fetchNetworkData(
  network: Network,
  from: number,
  to: number,
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
    );
    pools = poolsRes.Pool ?? [];
  } catch (err) {
    return {
      network,
      pools: [],
      snapshots: [],
      fees: null,
      error: err instanceof Error ? err : new Error(String(err)),
      feesError: null,
      snapshotsError: null,
    };
  }

  // Fees and snapshots are independent — run concurrently after pools succeeds.
  // Failures are surfaced per-field so the UI can show "N/A" rather than
  // silently reporting $0 or zero volume.
  const poolIds = pools.map((p) => p.id);
  const [feesResult, snapshotsResult] = await Promise.allSettled([
    client.request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
      PROTOCOL_FEE_TRANSFERS_ALL,
    ),
    shouldQueryPoolSnapshots24h(poolIds)
      ? client.request<{ PoolSnapshot: PoolSnapshot24h[] }>(
          POOL_SNAPSHOTS_24H,
          {
            from,
            to,
            poolIds,
          },
        )
      : Promise.resolve<{ PoolSnapshot: PoolSnapshot24h[] }>({
          PoolSnapshot: [],
        }),
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

  const snapshots =
    snapshotsResult.status === "fulfilled"
      ? (snapshotsResult.value.PoolSnapshot ?? [])
      : [];
  const snapshotsError =
    snapshotsResult.status === "rejected"
      ? snapshotsResult.reason instanceof Error
        ? snapshotsResult.reason
        : new Error(String(snapshotsResult.reason))
      : null;

  return {
    network,
    pools,
    snapshots,
    fees,
    error: null,
    feesError,
    snapshotsError,
  };
}

async function fetchAllNetworks(): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const { from, to } = snapshotWindow24h(Date.now());

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) => fetchNetworkData(NETWORKS[id], from, to)),
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return {
      network: NETWORKS[configuredNetworkIds[i]],
      pools: [],
      snapshots: [],
      fees: null,
      error:
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason)),
      feesError: null,
      snapshotsError: null,
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
    { refreshInterval: 300_000 },
  );

  return {
    networkData: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
