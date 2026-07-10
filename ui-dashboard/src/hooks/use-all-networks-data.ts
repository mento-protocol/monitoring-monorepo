"use client";

import useSWR, { useSWRConfig } from "swr";
import {
  fetchAllNetworks,
  isNetworkDataFullyHealthy,
  seedIncrementalRowCacheFromNetworkData,
  type NetworkData,
} from "@/lib/fetch-all-networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { SWR_KEY_ALL_NETWORKS_DATA } from "@/lib/swr-keys";

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

/**
 * SSR payloads younger than this skip mount revalidation entirely (first
 * paint fires 0 client GraphQL requests). Older ones still paint instantly
 * from `fallbackData` but revalidate immediately — the server cache serves
 * up to 5 min of staleness (MAX_SERVED_STALENESS_MS, tuned for production's
 * sparse ~15-min-gap traffic), and without this gate that staleness would
 * sit on screen until the next poll interval.
 */
export const SSR_FRESH_ENOUGH_MS = 60_000;

/**
 * Pure gate for the mount-revalidation skip: only a healthy, fresh-enough
 * SSR payload landing on a cold SWR cache may suppress the mount fetch.
 * Extracted so the composition is unit-testable without a render harness.
 */
export function shouldSkipMountRevalidation({
  hasFallback,
  allHealthy,
  isCacheCold,
  fallbackFetchedAtMs,
  nowMs,
}: {
  hasFallback: boolean;
  allHealthy: boolean;
  isCacheCold: boolean;
  fallbackFetchedAtMs: number | undefined;
  nowMs: number;
}): boolean {
  const isFreshEnough =
    fallbackFetchedAtMs !== undefined &&
    nowMs - fallbackFetchedAtMs < SSR_FRESH_ENOUGH_MS;
  return hasFallback && allHealthy && isCacheCold && isFreshEnough;
}

// Re-exports so long-established import sites keep working
// (`import { NetworkData, fetchAllNetworks, warnedCapKeys, ... } from
// "@/hooks/use-all-networks-data"`). New code should import directly from
// `@/lib/fetch-all-networks`.
export type { NetworkData } from "@/lib/fetch-all-networks";
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
 * - On a STALE-but-healthy SSR payload (the server cache serves up to
 *   MAX_SERVED_STALENESS_MS of staleness so sparse-traffic visitors get an
 *   instant paint), let SWR revalidate on mount so the stale numbers are on
 *   screen only for the ~1-2s the refetch takes, not until the next poll.
 *
 * Options are applied at this hook's call site rather than an ancestor
 * `SWRConfig` so they don't cascade to any other `useSWR` in the tree.
 */
export function useAllNetworksData(
  fallbackData?: NetworkData[],
  /** Fetch-completion time of `fallbackData`
   *  (`fetchInitialNetworkData().fetchedAtMs`). Omitted/unknown counts as
   *  stale — revalidate-on-mount is the safe default. */
  fallbackFetchedAtMs?: number,
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
  const skipRevalidation = shouldSkipMountRevalidation({
    hasFallback: fallbackData !== undefined,
    allHealthy,
    isCacheCold,
    fallbackFetchedAtMs,
    nowMs: Date.now(),
  });

  // Seed before `useSWR`: degraded SSR payloads intentionally revalidate on
  // mount, and that immediate fetch must still use the incremental snapshot
  // path for any complete slices present in the fallback.
  if (fallbackData !== undefined) {
    seedIncrementalRowCacheFromNetworkData(fallbackData);
  }

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

/**
 * Whether a page should render its initial-load skeleton. Only true on a
 * genuine cold load (no data yet). When a degraded SSR payload populated
 * `networkData` via `fallbackData`, this hook flips `revalidateOnMount: true`,
 * so SWR reports `isLoading` on the first render even though data already
 * exists — gating on `networkData.length` keeps the populated table visible
 * and avoids a layout-shift skeleton swap during the background retry. Shared
 * by the homepage and `/pools` so both pages stay consistent.
 */
export function showInitialSkeleton(
  isLoading: boolean,
  networkCount: number,
): boolean {
  return isLoading && networkCount === 0;
}
