"use client";

import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type IndexerNetworkId,
  type Network,
} from "@/lib/networks";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { ORACLE_RATES } from "@/lib/queries";
import { SNAPSHOT_REFRESH_MS } from "@/lib/volume";
import { buildOracleRateMap, type OracleRateMap } from "@/lib/tokens";
import type { Pool } from "@/lib/types";

type OracleRatesSlice = {
  network: Network;
  rates: OracleRateMap;
  error: Error | null;
};

export type OracleRatesResult = {
  /** Per-network rate map, one entry per configured network (empty on error). */
  byNetwork: OracleRatesSlice[];
  /** Union of per-network rate maps. First-wins on symbol collision — matches
   *  how the previous bridge/pool-detail code folded networkData[].rates. */
  merged: OracleRateMap;
  /** True while the first fetch is in-flight (no fallback data yet). */
  isLoading: boolean;
  /** True if at least one network's rate fetch failed. Callers that already
   *  tolerate partial data can keep rendering with the surviving rates. */
  hasAnyError: boolean;
};

type OracleRatesPool = Pick<
  Pool,
  "token0" | "token1" | "oraclePrice" | "oracleOk"
>;

async function fetchOneNetwork(network: Network): Promise<OracleRatesSlice> {
  if (!network.hasuraUrl) {
    return {
      network,
      rates: new Map(),
      error: new Error(`Hasura URL not configured for "${network.label}"`),
    };
  }
  const client = new GraphQLClient(network.hasuraUrl);
  try {
    const res = await client.request<{ Pool: OracleRatesPool[] }>(
      ORACLE_RATES,
      { chainId: network.chainId },
    );
    return {
      network,
      rates: buildOracleRateMap(res.Pool ?? [], network),
      error: null,
    };
  } catch (err) {
    return {
      network,
      rates: new Map(),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

async function fetchAllOracleRates(): Promise<OracleRatesSlice[]> {
  const ids = NETWORK_IDS.filter(isConfiguredNetworkId);
  return Promise.all(ids.map((id) => fetchOneNetwork(NETWORKS[id])));
}

/**
 * Lightweight oracle-rate hook. Fetches only the fields needed to build an
 * OracleRateMap per chain — currently ~5 fields × N pools, compared to the
 * 44-field ALL_POOLS_WITH_HEALTH payload that `useAllNetworksData` returns.
 *
 * Use on pages that only need USD conversion (bridge-flows, FX-pool
 * pool-detail) instead of calling `useAllNetworksData()` and discarding
 * the heavy slices. SWR cache-key is shared across consumers so two pages
 * on the same route-group reuse one fetch.
 */
export function useOracleRates(): OracleRatesResult {
  // Same polling-hardening as useGQL: no focus/reconnect revalidate, no
  // hidden-tab refresh, and 429-aware retry backoff from PR #202. Rates
  // move slowly so SNAPSHOT_REFRESH_MS (5 min) matches useAllNetworksData.
  const { data, isLoading } = useSWR<OracleRatesSlice[]>(
    "oracle-rates-all-networks",
    fetchAllOracleRates,
    {
      refreshInterval: SNAPSHOT_REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );

  const byNetwork = data ?? [];
  const merged: OracleRateMap = new Map();
  for (const slice of byNetwork) {
    for (const [symbol, rate] of slice.rates.entries()) {
      if (!merged.has(symbol)) merged.set(symbol, rate);
    }
  }
  const hasAnyError = byNetwork.some((s) => s.error !== null);

  return { byNetwork, merged, isLoading, hasAnyError };
}

/** Pull a single network's rate map from the already-fetched slices. */
export function ratesForNetwork(
  result: OracleRatesResult,
  networkId: IndexerNetworkId,
): OracleRateMap {
  return (
    result.byNetwork.find((s) => s.network.id === networkId)?.rates ?? new Map()
  );
}
