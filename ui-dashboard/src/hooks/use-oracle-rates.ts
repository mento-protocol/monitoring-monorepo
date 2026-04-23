"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { GraphQLClient } from "graphql-request";
import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type Network,
} from "@/lib/networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { ORACLE_RATES } from "@/lib/queries";
import {
  buildOracleRateMap,
  type OracleRateMap,
  type OracleRatePool,
} from "@/lib/tokens";
import { SWR_KEY_ORACLE_RATES } from "@/lib/swr-keys";
import { REQUEST_TIMEOUT_MS } from "@/lib/fetch-all-networks";

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

async function fetchOneNetwork(network: Network): Promise<OracleRatesSlice> {
  if (!network.hasuraUrl) {
    return {
      network,
      rates: new Map(),
      error: new Error(`Hasura URL not configured for "${network.label}"`),
    };
  }
  try {
    const client = new GraphQLClient(network.hasuraUrl);
    const res = await client.request<{ Pool: OracleRatePool[] }>({
      document: ORACLE_RATES,
      variables: { chainId: network.chainId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
  const { data, isLoading } = useSWR<OracleRatesSlice[]>(
    SWR_KEY_ORACLE_RATES,
    fetchAllOracleRates,
    SHARED_QUERY_SWR_CONFIG,
  );

  // Memoize on `data` directly — `data ?? []` produces a fresh array every
  // render while loading (data === undefined), which would cache-bust the
  // memo and allocate a new empty Map each pass. Depending on `data` means
  // the merged Map is stable across renders in both loading and populated
  // states, giving downstream `useMemo`s that read `rates` a stable input.
  const merged = useMemo<OracleRateMap>(() => {
    const out: OracleRateMap = new Map();
    if (!data) return out;
    for (const slice of data) {
      for (const [symbol, rate] of slice.rates.entries()) {
        if (!out.has(symbol)) out.set(symbol, rate);
      }
    }
    return out;
  }, [data]);
  const byNetwork = data ?? [];
  const hasAnyError = byNetwork.some((s) => s.error !== null);

  return { byNetwork, merged, isLoading, hasAnyError };
}
