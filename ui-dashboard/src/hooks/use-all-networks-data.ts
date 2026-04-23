"use client";

import useSWR, { useSWRConfig } from "swr";
import {
  fetchAllNetworks,
  isNetworkDataFullyHealthy,
  type NetworkData,
} from "@/lib/fetch-all-networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { SWR_KEY_ALL_NETWORKS_DATA } from "@/lib/swr-keys";

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

// Re-exports so long-established import sites keep working
// (`import { NetworkData, fetchAllNetworks, warnedCapKeys, ... } from
// "@/hooks/use-all-networks-data"`). New code should import directly from
// `@/lib/fetch-all-networks`.
export type { NetworkData, SnapshotPageResult } from "@/lib/fetch-all-networks";
export {
  fetchAllNetworks,
  fetchNetworkData,
  warnedCapKeys,
  partialPageLastCapturedAt,
} from "@/lib/fetch-all-networks";

/**
 * Fetches pools, full-history daily snapshots (paginated), protocol fees, and
 * LP counts for ALL configured networks in parallel.
 *
 * Optional `fallbackData` lets a Server Component pre-render the payload and
 * hand it off to this hook. The revalidation skip is **cache-aware** to
 * resolve the tension between two failure modes:
 *
 * - On a COLD cache (first visit within a session) with a healthy SSR
 *   payload, skip mount- and stale-revalidation so first paint fires 0
 *   client GraphQL requests.
 * - On a WARM cache (back-navigation; `/pools` and `/` share this key and
 *   its poll cycle may have already populated it), let SWR revalidate so
 *   stale cached entries get refreshed — otherwise the user can see
 *   cached data up to 5 min old until the next interval fires.
 * - On any SSR degradation (per-slice or per-chain error), let SWR
 *   revalidate on mount so partial `N/A` metrics recover immediately
 *   instead of being pinned until the next poll.
 *
 * Options are applied at this hook's call site rather than an ancestor
 * `SWRConfig` so they don't cascade to any other `useSWR` in the tree.
 */
export function useAllNetworksData(
  fallbackData?: NetworkData[],
): AllNetworksResult {
  const { cache } = useSWRConfig();
  const allHealthy =
    fallbackData !== undefined && fallbackData.every(isNetworkDataFullyHealthy);
  // Reading cache at render time is intentional: when the cache is cold we
  // want fallbackData to win with zero revalidation; when warm, SWR's
  // default stale-check should fire to refresh cached data that could be
  // older than the SSR payload. The read is synchronous and idempotent —
  // `cache.get` doesn't mutate state.
  const isCacheCold = cache.get(SWR_KEY_ALL_NETWORKS_DATA)?.data === undefined;
  const skipRevalidation =
    fallbackData !== undefined && allHealthy && isCacheCold;
  const { data, error, isLoading } = useSWR<NetworkData[]>(
    SWR_KEY_ALL_NETWORKS_DATA,
    fetchAllNetworks,
    {
      ...SHARED_QUERY_SWR_CONFIG,
      ...(fallbackData !== undefined && { fallbackData }),
      // When `fallbackData` is present, SWR's default for `revalidateOnMount`
      // flips to `false`. That's what we want in the skip case (cold cache +
      // healthy SSR → 0 client requests on first paint). In every other
      // branch (degraded SSR, or warm cache that may hold stale data), we
      // must explicitly opt IN to mount revalidation — otherwise the default
      // silently defeats the recovery path.
      ...(skipRevalidation
        ? { revalidateOnMount: false, revalidateIfStale: false }
        : { revalidateOnMount: true }),
    },
  );

  return {
    networkData: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
