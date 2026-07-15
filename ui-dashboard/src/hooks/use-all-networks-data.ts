"use client";

import { useCallback, useMemo, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  fetchAllNetworks,
  isNetworkDataFullyHealthy,
  seedIncrementalRowCacheFromNetworkData,
  type InitialNetworkData,
  type NetworkData,
} from "@/lib/fetch-all-networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { SWR_KEY_ALL_NETWORKS_DATA } from "@/lib/swr-keys";
import { useLivePoolHealth } from "@/hooks/use-live-pool-health";
import { buildDailySnapshotSlices } from "@/lib/volume";

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
  /** True while the visible data still carries the bounded SSR history. */
  isSnapshotHistoryCapped: boolean;
  /** Unexpected failure from an on-demand full-history revalidation. */
  snapshotHistoryError: Error | null;
  /** Coalesced normal SWR revalidation used by the homepage "All" charts. */
  requestFullSnapshotHistory: () => Promise<void>;
};

const EMPTY_NETWORK_DATA: NetworkData[] = [];

// One browser-tab fetch boundary for the shared all-networks SWR key. Multiple
// hook instances can coexist briefly during route transitions; SWR normally
// dedupes them, but an imperative mutate in one instance can overlap a mount or
// polling revalidation in another. Share only the raw fleet fan-out here, then
// let each caller reconcile that result against its own last-good data.
let allNetworksFetchInFlight: Promise<NetworkData[]> | null = null;

function fetchAllNetworksAtBoundary(): Promise<NetworkData[]> {
  if (allNetworksFetchInFlight !== null) return allNetworksFetchInFlight;

  const request = fetchAllNetworks();
  allNetworksFetchInFlight = request;
  void request.then(
    () => {
      if (allNetworksFetchInFlight === request) allNetworksFetchInFlight = null;
    },
    () => {
      if (allNetworksFetchInFlight === request) allNetworksFetchInFlight = null;
    },
  );
  return request;
}

function cappedSnapshotHistoryFailure(
  networkData: readonly NetworkData[],
): Error | null {
  for (const network of networkData) {
    if (network.snapshotsAllDailyCapped) {
      if (network.snapshotsAllDailyError != null) {
        return new Error(network.snapshotsAllDailyError.message);
      }
      if (network.snapshotsAllDailyTruncated) {
        return new Error("Full snapshot history pagination was truncated");
      }
    }
    if (network.brokerSnapshotsAllDailyCapped === true) {
      if (network.brokerSnapshotsAllDailyError != null) {
        return new Error(network.brokerSnapshotsAllDailyError.message);
      }
      if (network.brokerSnapshotsAllDailyTruncated) {
        return new Error("Full Broker history pagination was truncated");
      }
    }
  }
  return null;
}

function vpCursorRegressed(
  current: string | undefined,
  previous: string | undefined,
): boolean {
  if (previous === undefined) return false;
  if (
    current === undefined ||
    !/^\d+$/.test(current) ||
    !/^\d+$/.test(previous)
  ) {
    return true;
  }
  return BigInt(current) < BigInt(previous);
}

/** Preserve last-confirmed VirtualPool extension groups when a later fleet
 * fan-out rejects or omits a companion entity. The oracle fields are one
 * atomic observation, deprecation is monotonic, and wrapper quorum config is
 * health-critical; losing any of them must disclose degradation instead of
 * changing the pool's classification. */
export function retainConfirmedVpExtensions(
  current: NetworkData[],
  previous: NetworkData[] | undefined,
): NetworkData[] {
  if (previous === undefined) return current;
  const previousByNetwork = new Map(
    previous.map((data) => [data.network.id, data] as const),
  );
  return current.map((data) => {
    const prior = previousByNetwork.get(data.network.id);
    if (!prior) return data;
    const priorPools = new Map(prior.pools.map((pool) => [pool.id, pool]));
    let retainedCount = 0;
    let retainedFleetRefreshSignalCount = 0;
    const pools = data.pools.map((pool) => {
      const previousPool = priorPools.get(pool.id);
      if (!previousPool) return pool;
      const retainDeprecation =
        previousPool.wrappedExchangeDeprecated === true &&
        pool.wrappedExchangeDeprecated !== true;
      const retainMinimumReports =
        previousPool.wrappedExchangeMinimumReports !== undefined &&
        pool.wrappedExchangeMinimumReports === undefined;
      const retainDeprecationTrust =
        previousPool.vpDeprecationKnown === true &&
        pool.vpDeprecationKnown !== true;
      const retainFreshness =
        previousPool.vpOracleFreshnessCheckedAt !== undefined &&
        (pool.vpOracleFreshnessCheckedAt === undefined ||
          vpCursorRegressed(
            pool.vpHealthUpdatedAtBlock,
            previousPool.vpHealthUpdatedAtBlock,
          ));
      if (
        !retainDeprecation &&
        !retainMinimumReports &&
        !retainDeprecationTrust &&
        !retainFreshness
      ) {
        return pool;
      }
      retainedCount += 1;
      retainedFleetRefreshSignalCount += [
        retainDeprecation,
        retainMinimumReports,
        retainDeprecationTrust,
      ].filter(Boolean).length;
      return {
        ...pool,
        ...(retainDeprecation ? { wrappedExchangeDeprecated: true } : {}),
        ...(retainDeprecationTrust ? { vpDeprecationKnown: true } : {}),
        ...(retainMinimumReports
          ? {
              wrappedExchangeMinimumReports:
                previousPool.wrappedExchangeMinimumReports,
            }
          : {}),
        ...(retainFreshness
          ? {
              lastOracleReportAt: previousPool.lastOracleReportAt,
              medianLive: previousPool.medianLive,
              oracleFreshnessWindow: previousPool.oracleFreshnessWindow,
              vpHealthUpdatedAtBlock: previousPool.vpHealthUpdatedAtBlock,
              vpOracleTimestamp: previousPool.vpOracleTimestamp,
              vpOracleNumReporters: previousPool.vpOracleNumReporters,
              vpTokenDecimalsKnown: previousPool.vpTokenDecimalsKnown,
              vpOracleFreshnessCheckedAt:
                previousPool.vpOracleFreshnessCheckedAt,
            }
          : {}),
      };
    });
    if (retainedCount === 0) return data;
    return {
      ...data,
      pools,
      liveHealthError:
        data.liveHealthError ??
        ({
          message: `Pool health response did not reconfirm ${retainedCount} VirtualPool extension${retainedCount === 1 ? "" : "s"}`,
        } as const),
      liveHealthErrorClearsOnLivePoll:
        retainedFleetRefreshSignalCount === 0 &&
        (data.liveHealthError === null ||
          data.liveHealthError === undefined ||
          data.liveHealthErrorClearsOnLivePoll === true),
    };
  });
}

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

/**
 * Restore the 1/7/30-day arrays deliberately omitted from the Server
 * Component transport. This runs synchronously before health evaluation,
 * incremental-cache seeding, and SWR fallback installation, preserving the
 * same initial HTML and consumer contract without serializing duplicate rows.
 */
function restoreInitialSnapshotSlices(data: InitialNetworkData): NetworkData {
  const { snapshots, snapshots7d, snapshots30d } = buildDailySnapshotSlices(
    data.snapshotsAllDaily,
    data.snapshotWindows.w24h.to,
  );
  return { ...data, snapshots, snapshots7d, snapshots30d };
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
  fallbackData?: InitialNetworkData[],
  /** Fetch-completion time of `fallbackData`
   *  (`fetchInitialNetworkData(route).fetchedAtMs`). Omitted/unknown counts as
   *  stale — revalidate-on-mount is the safe default. */
  fallbackFetchedAtMs?: number,
): AllNetworksResult {
  const { cache } = useSWRConfig();
  const fullHistoryRequestRef = useRef<Promise<void> | null>(null);
  // SWR dedupes ordinary revalidations, but a user-triggered `mutate()` may
  // still invoke the fetcher while mount or polling revalidation is already in
  // flight. Coalesce at the actual fetch boundary so every trigger shares one
  // fleet fan-out and receives the same reconciled result.
  const networkFetchRef = useRef<Promise<NetworkData[]> | null>(null);
  const restoredFallbackData = useMemo(
    () => fallbackData?.map(restoreInitialSnapshotSlices),
    [fallbackData],
  );
  const allHealthy =
    restoredFallbackData !== undefined &&
    restoredFallbackData.every(isNetworkDataFullyHealthy);
  // Reading cache at render time is intentional: when the cache is cold we
  // want fallbackData to win with zero revalidation; when warm, SWR's
  // default stale-check should fire to refresh cached data that could be
  // older than the SSR payload. The read is synchronous and idempotent —
  // `cache.get` doesn't mutate state.
  const isCacheCold = cache.get(SWR_KEY_ALL_NETWORKS_DATA)?.data === undefined;
  const skipRevalidation = shouldSkipMountRevalidation({
    hasFallback: restoredFallbackData !== undefined,
    allHealthy,
    isCacheCold,
    fallbackFetchedAtMs,
    nowMs: Date.now(),
  });

  // Seed before `useSWR`: complete slices can take the incremental path, while
  // a bounded SSR slice is retained as incomplete last-good data and forces
  // from-zero pagination when mount recovery or an "All" interaction fetches.
  if (restoredFallbackData !== undefined) {
    seedIncrementalRowCacheFromNetworkData(restoredFallbackData);
  }

  const fetcher = useCallback(() => {
    if (networkFetchRef.current !== null) return networkFetchRef.current;

    const request = fetchAllNetworksAtBoundary().then((current) => {
      const cached = cache.get(SWR_KEY_ALL_NETWORKS_DATA)?.data;
      const previous = Array.isArray(cached)
        ? (cached as NetworkData[])
        : restoredFallbackData;
      return retainConfirmedVpExtensions(current, previous);
    });
    networkFetchRef.current = request;
    void request.then(
      () => {
        if (networkFetchRef.current === request) networkFetchRef.current = null;
      },
      () => {
        if (networkFetchRef.current === request) networkFetchRef.current = null;
      },
    );
    return request;
  }, [cache, restoredFallbackData]);
  const { data, error, isLoading, mutate } = useSWR<NetworkData[]>(
    SWR_KEY_ALL_NETWORKS_DATA,
    fetcher,
    {
      ...SHARED_QUERY_SWR_CONFIG,
      ...(restoredFallbackData !== undefined && {
        fallbackData: restoredFallbackData,
      }),
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
  const isSnapshotHistoryCapped = (
    data ??
    restoredFallbackData ??
    EMPTY_NETWORK_DATA
  ).some(
    (network) =>
      network.snapshotsAllDailyCapped ||
      network.brokerSnapshotsAllDailyCapped === true,
  );
  const snapshotHistoryNetworkError = cappedSnapshotHistoryFailure(
    data ?? restoredFallbackData ?? EMPTY_NETWORK_DATA,
  );
  const requestFullSnapshotHistory = useCallback((): Promise<void> => {
    if (!isSnapshotHistoryCapped) return Promise.resolve();
    if (fullHistoryRequestRef.current !== null) {
      return fullHistoryRequestRef.current;
    }
    // `mutate()` runs this hook's normal `fetchAllNetworks` fetcher. Because
    // capped SSR rows are seeded as incomplete, the snapshot paginator starts
    // from timestamp 0; other consumers keep the same SWR key and failure
    // semantics. Swallow the promise rejection here—the SWR `error` channel
    // below is what renders an honest unavailable state for the selected
    // "All" range.
    const request = mutate()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        fullHistoryRequestRef.current = null;
      });
    fullHistoryRequestRef.current = request;
    return request;
  }, [isSnapshotHistoryCapped, mutate]);
  const liveHealth = useLivePoolHealth(data ?? EMPTY_NETWORK_DATA);

  return {
    networkData: liveHealth.networkData,
    isLoading,
    error: error instanceof Error ? error : liveHealth.error,
    isSnapshotHistoryCapped,
    snapshotHistoryError:
      isSnapshotHistoryCapped && error instanceof Error
        ? error
        : snapshotHistoryNetworkError,
    requestFullSnapshotHistory,
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
