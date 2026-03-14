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
  pools: Pool[];
  snapshots: PoolSnapshot24h[];
  fees: ProtocolFeeSummary | null;
  error: Error | null;
};

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

async function fetchNetworkData(
  network: Network,
  from: number,
  to: number,
): Promise<NetworkData> {
  const client = new GraphQLClient(network.hasuraUrl, {
    headers: network.hasuraSecret
      ? { "x-hasura-admin-secret": network.hasuraSecret }
      : {},
  });

  try {
    // Fetch pools and fees in parallel
    const [poolsRes, feesRes] = await Promise.all([
      client.request<{ Pool: Pool[] }>(ALL_POOLS_WITH_HEALTH),
      client
        .request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
          PROTOCOL_FEE_TRANSFERS_ALL,
        )
        .catch(() => null),
    ]);

    const pools = poolsRes.Pool ?? [];
    const fees = feesRes
      ? aggregateProtocolFees(feesRes.ProtocolFeeTransfer ?? [])
      : null;

    // Fetch 24h snapshots for relevant pools
    const poolIds = pools.map((p) => p.id);
    let snapshots: PoolSnapshot24h[] = [];
    if (shouldQueryPoolSnapshots24h(poolIds)) {
      const snapshotsRes = await client
        .request<{ PoolSnapshot: PoolSnapshot24h[] }>(POOL_SNAPSHOTS_24H, {
          from,
          to,
          poolIds,
        })
        .catch(() => null);
      snapshots = snapshotsRes?.PoolSnapshot ?? [];
    }

    return { network, pools, snapshots, fees, error: null };
  } catch (err) {
    return {
      network,
      pools: [],
      snapshots: [],
      fees: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

async function fetchAllNetworks(_key: string): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const { from, to } = snapshotWindow24h(Date.now());

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) =>
      fetchNetworkData(NETWORKS[id], from, to),
    ),
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
    };
  });
}

/**
 * Fetches pools, 24h snapshots, and protocol fees for ALL configured networks.
 * Uses Promise.allSettled so one failing network doesn't break the others.
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
