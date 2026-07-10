"use client";

import { useCallback, useMemo } from "react";
import { GraphQLClient } from "graphql-request";
import useSWR, { useSWRConfig } from "swr";
import type { AllPoolsLiveHealthQuery } from "@/lib/__generated__/graphql";
import { retryAfterMs, SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type IndexerNetworkId,
  type Network,
} from "@/lib/networks";
import { ALL_POOLS_LIVE_HEALTH } from "@/lib/queries";
import { REQUEST_TIMEOUT_MS, type NetworkData } from "@/lib/fetch-all-networks";
import { SWR_KEY_LIVE_POOL_HEALTH } from "@/lib/swr-keys";
import { isVirtualPool, type Pool } from "@/lib/types";

/** Health needs a cadence shorter than the 5-6 minute oracle expiry. The
 * expensive snapshot/fee/LP fan-out remains on its existing 5 minute poll. */
const LIVE_POOL_HEALTH_REFRESH_MS = 30_000;
let liveHealthReceiptSequence = 0;
// Shared across `/` and `/pools`, just like the SWR cache itself. A hook-local
// deadline would be forgotten on navigation and immediately violate a
// network's Retry-After instruction during mount revalidation.
const liveHealthBackoffUntilByNetwork = new Map<IndexerNetworkId, number>();
// A fleet payload keeps the same identity in SWR across `/` and `/pools`.
// Remember its receipt order at cache scope so remounting cannot make that old
// payload appear newer than a same-block live slice already in the shared SWR
// cache. Weak keys avoid retaining superseded fleet payloads.
const fleetReceiptSequenceByPayload = new WeakMap<NetworkData[], number>();

function nextLiveHealthReceiptSequence(): number {
  liveHealthReceiptSequence += 1;
  return liveHealthReceiptSequence;
}

function fleetReceiptSequence(networkData: NetworkData[]): number {
  const existing = fleetReceiptSequenceByPayload.get(networkData);
  if (existing !== undefined) return existing;
  const sequence = nextLiveHealthReceiptSequence();
  fleetReceiptSequenceByPayload.set(networkData, sequence);
  return sequence;
}

export type LivePoolHealthRow = AllPoolsLiveHealthQuery["Pool"][number] & {
  oracleFreshnessCheckedAt: number;
};

export type LivePoolHealthSlice = {
  networkId: IndexerNetworkId;
  pools: LivePoolHealthRow[];
  error: Error | null;
  /** Client-local receipt order. Unlike epoch timestamps, this is safe to
   * compare across cached live rows and newly arrived fleet payloads. */
  receiptSequence?: number | undefined;
  /** Rows retained from the prior confirmed slice because a successful
   * refresh omitted them or returned an older indexer row. Consumers expose
   * degradation until a current row reappears or the slower fleet payload
   * confirms the pool itself is gone. */
  retainedPoolIds?: string[] | undefined;
};

async function fetchNetworkLivePoolHealth(
  network: Network,
): Promise<LivePoolHealthSlice> {
  // Order by request start, not response completion. If the slower fleet query
  // lands while this request is already in flight, its equal-version snapshot
  // must win even if this HTTP response happens to finish afterward.
  const receiptSequence = nextLiveHealthReceiptSequence();
  if (!network.hasuraUrl) {
    return {
      networkId: network.id,
      pools: [],
      error: new Error(`Hasura URL not configured for "${network.label}"`),
      receiptSequence,
    };
  }

  try {
    const client = new GraphQLClient(network.hasuraUrl);
    const response = await client.request<AllPoolsLiveHealthQuery>({
      document: ALL_POOLS_LIVE_HEALTH,
      variables: { chainId: network.chainId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const checkedAt = Date.now() / 1000;
    return {
      networkId: network.id,
      pools: response.Pool.map((pool) => ({
        ...pool,
        oracleFreshnessCheckedAt: checkedAt,
      })),
      error: null,
      receiptSequence,
    };
  } catch (error) {
    return {
      networkId: network.id,
      pools: [],
      error: error instanceof Error ? error : new Error(String(error)),
      receiptSequence,
    };
  }
}

async function fetchAllLivePoolHealth(
  previous: LivePoolHealthSlice[] | undefined,
  backoffUntilByNetwork: Map<IndexerNetworkId, number>,
): Promise<LivePoolHealthSlice[]> {
  const ids = NETWORK_IDS.filter(isConfiguredNetworkId);
  const previousByNetwork = new Map(
    previous?.map((slice) => [slice.networkId, slice] as const) ?? [],
  );
  return Promise.all(
    ids.map(async (id) => {
      const prior = previousByNetwork.get(id);
      const backoffUntil = backoffUntilByNetwork.get(id) ?? 0;
      if (prior !== undefined && Date.now() < backoffUntil) return prior;

      const slice = await fetchNetworkLivePoolHealth(NETWORKS[id]);
      const backoffMs = retryAfterMs(slice.error);
      if (backoffMs === null) backoffUntilByNetwork.delete(id);
      else backoffUntilByNetwork.set(id, Date.now() + backoffMs);
      return slice;
    }),
  );
}

function parseMonotonicCursor(value: string | undefined): bigint | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function liveCursorIsCurrent(
  baseCursor: string | undefined,
  liveCursor: string | undefined,
): boolean {
  const base = parseMonotonicCursor(baseCursor);
  if (base === null) return true;
  const live = parseMonotonicCursor(liveCursor);
  return live !== null && live >= base;
}

function compareLiveCursor(
  baseCursor: string | undefined,
  liveCursor: string | undefined,
): -1 | 0 | 1 | null {
  const base = parseMonotonicCursor(baseCursor);
  const live = parseMonotonicCursor(liveCursor);
  if (base === null || live === null) return null;
  if (live < base) return -1;
  if (live > base) return 1;
  return 0;
}

function hasConfirmedFreshnessCheck(pool: {
  oracleFreshnessCheckedAt?: number | undefined;
}): boolean {
  const checkedAt = pool.oracleFreshnessCheckedAt;
  return checkedAt !== undefined && Number.isFinite(checkedAt) && checkedAt > 0;
}

/** A refresh failure, omission, or regressed row is degradation metadata, not
 * a new health observation. Keep each network's last confirmed rows so those
 * cases cannot roll a newly confirmed CRITICAL/OK state back to the slower
 * five-minute fleet payload. */
export function retainLastSuccessfulLivePoolHealth(
  current: LivePoolHealthSlice[],
  previous: LivePoolHealthSlice[] | undefined,
): LivePoolHealthSlice[] {
  if (previous === undefined) return current;
  const previousByNetwork = new Map(
    previous.map((slice) => [slice.networkId, slice] as const),
  );
  return current.map((slice) => {
    const lastConfirmed = previousByNetwork.get(slice.networkId);
    if (!lastConfirmed || lastConfirmed.pools.length === 0) return slice;
    if (slice.error === null) {
      const previousById = new Map(
        lastConfirmed.pools.map((pool) => [pool.id, pool] as const),
      );
      const retainedPoolIds: string[] = [];
      const reconciledPools = slice.pools.map((pool) => {
        const prior = previousById.get(pool.id);
        if (
          prior === undefined ||
          liveCursorIsCurrent(prior.updatedAtBlock, pool.updatedAtBlock)
        ) {
          return pool;
        }
        retainedPoolIds.push(pool.id);
        return prior;
      });
      const currentIds = new Set(slice.pools.map((pool) => pool.id));
      const omittedPools = lastConfirmed.pools.filter(
        (pool) => !currentIds.has(pool.id),
      );
      retainedPoolIds.push(...omittedPools.map((pool) => pool.id));
      if (retainedPoolIds.length === 0) return slice;
      return {
        ...slice,
        pools: [...reconciledPools, ...omittedPools],
        retainedPoolIds,
      };
    }
    return {
      ...lastConfirmed,
      error: slice.error,
      retainedPoolIds: lastConfirmed.pools.map((pool) => pool.id),
    };
  });
}

function livePrimaryHealthIsCurrent(
  base: Pick<
    Pool,
    "oracleFreshnessCheckedAt" | "updatedAtBlock" | "updatedAtTimestamp"
  >,
  live: Pick<LivePoolHealthRow, "updatedAtBlock" | "updatedAtTimestamp">,
  liveCanReplaceEqualVersion: boolean,
): boolean {
  if (parseMonotonicCursor(base.updatedAtBlock) !== null) {
    const blockOrder = compareLiveCursor(
      base.updatedAtBlock,
      live.updatedAtBlock,
    );
    if (blockOrder === null) return false;
    if (blockOrder !== 0) return blockOrder > 0;
    // An equal block contains the same indexed entity state. Accept the live
    // row only when its request started after this fleet payload arrived. A
    // cached/retained row must not replace a newer fleet observation at the
    // same block; server and browser clocks are not comparable.
    return liveCanReplaceEqualVersion || !hasConfirmedFreshnessCheck(base);
  }
  const timestampOrder = compareLiveCursor(
    base.updatedAtTimestamp,
    live.updatedAtTimestamp,
  );
  if (timestampOrder !== null) {
    if (timestampOrder !== 0) return timestampOrder > 0;
    return liveCanReplaceEqualVersion || !hasConfirmedFreshnessCheck(base);
  }
  return liveCanReplaceEqualVersion || !hasConfirmedFreshnessCheck(base);
}

function liveExtensionHealthIsCurrent(
  baseUpdatedAtBlock: string | undefined,
  liveUpdatedAtBlock: string,
  liveCanReplaceEqualVersion: boolean,
): boolean {
  const order = compareLiveCursor(baseUpdatedAtBlock, liveUpdatedAtBlock);
  if (order === null) {
    return (
      parseMonotonicCursor(baseUpdatedAtBlock) === null &&
      parseMonotonicCursor(liveUpdatedAtBlock) !== null
    );
  }
  return order > 0 || (order === 0 && liveCanReplaceEqualVersion);
}

function markFreshnessCheckPending(pool: Pool): Pool {
  if (
    hasConfirmedFreshnessCheck(pool) ||
    pool.oracleFreshnessCheckPending === true
  ) {
    return pool;
  }
  return { ...pool, oracleFreshnessCheckPending: true };
}

function liveRowConfirmsEveryHealthGroup(
  pool: Pool,
  row: LivePoolHealthRow,
): boolean {
  return (
    livePrimaryHealthIsCurrent(pool, row, true) &&
    liveExtensionHealthIsCurrent(
      pool.thresholdHealthUpdatedAtBlock,
      row.updatedAtBlock,
      true,
    ) &&
    (!isVirtualPool(pool) ||
      liveExtensionHealthIsCurrent(
        pool.vpHealthUpdatedAtBlock,
        row.updatedAtBlock,
        true,
      ))
  );
}

function liveRowAdvancesAnyHealthGroup(
  pool: Pool,
  row: LivePoolHealthRow,
): boolean {
  return (
    livePrimaryHealthIsCurrent(pool, row, false) ||
    liveExtensionHealthIsCurrent(
      pool.thresholdHealthUpdatedAtBlock,
      row.updatedAtBlock,
      false,
    ) ||
    (isVirtualPool(pool) &&
      liveExtensionHealthIsCurrent(
        pool.vpHealthUpdatedAtBlock,
        row.updatedAtBlock,
        false,
      ))
  );
}

function liveRowAdvancesEveryHealthGroup(
  pool: Pool,
  row: LivePoolHealthRow,
): boolean {
  return (
    livePrimaryHealthIsCurrent(pool, row, false) &&
    liveExtensionHealthIsCurrent(
      pool.thresholdHealthUpdatedAtBlock,
      row.updatedAtBlock,
      false,
    ) &&
    (!isVirtualPool(pool) ||
      liveExtensionHealthIsCurrent(
        pool.vpHealthUpdatedAtBlock,
        row.updatedAtBlock,
        false,
      ))
  );
}

function liveSliceConfirmsFleetErrorRecovery({
  pools,
  rowsById,
  retainedPoolIds,
  liveError,
  liveReceiptIsNewer,
}: {
  pools: Pool[];
  rowsById: Map<string, LivePoolHealthRow>;
  retainedPoolIds: Set<string>;
  liveError: Error | null;
  liveReceiptIsNewer: boolean;
}): boolean {
  if (liveError !== null) return false;
  if (pools.some((pool) => retainedPoolIds.has(pool.id))) return false;
  const everyGroupConfirmed = pools.every((pool) => {
    const row = rowsById.get(pool.id);
    return row !== undefined && liveRowConfirmsEveryHealthGroup(pool, row);
  });
  if (!everyGroupConfirmed) return false;
  if (liveReceiptIsNewer) return true;
  return pools.every((pool) => {
    const row = rowsById.get(pool.id);
    return row !== undefined && liveRowAdvancesEveryHealthGroup(pool, row);
  });
}

function mergeLiveHealthRow(
  pool: Pool,
  row: LivePoolHealthRow,
  liveCanReplaceEqualVersion: boolean,
): Pool {
  let merged = markFreshnessCheckPending(pool);
  if (livePrimaryHealthIsCurrent(pool, row, liveCanReplaceEqualVersion)) {
    merged = {
      ...merged,
      updatedAtBlock: row.updatedAtBlock,
      updatedAtTimestamp: row.updatedAtTimestamp,
      oracleOk: row.oracleOk,
      oracleTimestamp: row.oracleTimestamp,
      oracleExpiry: row.oracleExpiry,
      oracleNumReporters: row.oracleNumReporters,
      priceDifference: row.priceDifference,
      rebalanceThreshold: row.rebalanceThreshold,
      deviationBreachStartedAt: row.deviationBreachStartedAt,
      lastRebalancedAt: row.lastRebalancedAt,
      hasHealthData: row.hasHealthData,
      limitStatus: row.limitStatus,
      limitPressure0: row.limitPressure0,
      limitPressure1: row.limitPressure1,
      oracleFreshnessCheckedAt: row.oracleFreshnessCheckedAt,
      oracleFreshnessCheckPending: false,
    };
  }
  if (
    liveExtensionHealthIsCurrent(
      pool.thresholdHealthUpdatedAtBlock,
      row.updatedAtBlock,
      liveCanReplaceEqualVersion,
    )
  ) {
    merged = {
      ...merged,
      rebalanceThresholdAbove: row.rebalanceThresholdAbove,
      rebalanceThresholdBelow: row.rebalanceThresholdBelow,
      rebalanceThresholdsKnown: row.rebalanceThresholdsKnown,
      tokenDecimalsKnown: row.tokenDecimalsKnown,
      degenerateReserves: row.degenerateReserves,
      breakerTripped: row.breakerTripped,
      thresholdHealthUpdatedAtBlock: row.updatedAtBlock,
    };
  }
  if (
    isVirtualPool(pool) &&
    liveExtensionHealthIsCurrent(
      pool.vpHealthUpdatedAtBlock,
      row.updatedAtBlock,
      liveCanReplaceEqualVersion,
    )
  ) {
    merged = {
      ...merged,
      medianLive: row.medianLive,
      oracleFreshnessWindow: row.oracleFreshnessWindow,
      vpHealthUpdatedAtBlock: row.updatedAtBlock,
      vpOracleTimestamp: row.oracleTimestamp,
      vpOracleNumReporters: row.oracleNumReporters,
      vpTokenDecimalsKnown: row.tokenDecimalsKnown,
      vpOracleFreshnessCheckedAt: row.oracleFreshnessCheckedAt,
    };
  }
  return merged;
}

/** Merge the lightweight, frequently-polled fields into the slower fleet
 * payload without allowing an older live response to overwrite a newer full
 * fetch. Failed networks keep their last successful live rows and expose a
 * separate degradation channel. */
export function mergeLivePoolHealth(
  networkData: NetworkData[],
  liveSlices: LivePoolHealthSlice[] | undefined,
  pending: boolean,
  baseReceiptSequence = Number.NEGATIVE_INFINITY,
): NetworkData[] {
  if (pending) {
    return networkData.map((data) => ({
      ...data,
      pools: data.pools.map(markFreshnessCheckPending),
    }));
  }
  if (liveSlices === undefined) {
    return networkData.map((data) => ({
      ...data,
      pools: data.pools.map(markFreshnessCheckPending),
    }));
  }

  const liveByNetwork = new Map(
    liveSlices.map((slice) => [slice.networkId, slice] as const),
  );
  return networkData.map((data) => {
    const live = liveByNetwork.get(data.network.id);
    if (!live) return data;
    const rowsById = new Map(
      live.pools.map((pool) => [pool.id, pool] as const),
    );
    const retainedPoolIds = new Set(live.retainedPoolIds ?? []);
    const liveReceiptIsNewer =
      live.receiptSequence === undefined ||
      live.receiptSequence > baseReceiptSequence;
    const unconfirmedPoolCount = data.pools.filter((pool) => {
      const row = rowsById.get(pool.id);
      if (!row) return liveReceiptIsNewer;
      const olderLiveRepairsFleet =
        !liveReceiptIsNewer && liveRowAdvancesAnyHealthGroup(pool, row);
      if (retainedPoolIds.has(pool.id)) {
        return liveReceiptIsNewer || olderLiveRepairsFleet;
      }
      // An intentionally older cached live slice yields to a newer fleet
      // payload without claiming degradation. It may still contain a higher
      // block when the live request overlapped the fleet's slower fan-out; in
      // that normal case we merge the newer row silently. A genuinely newer
      // live request must confirm all independently versioned health groups;
      // otherwise the base is retained and the omission/regression is
      // disclosed.
      return liveReceiptIsNewer && !liveRowConfirmsEveryHealthGroup(pool, row);
    }).length;
    const liveConfirmsEveryDisplayedPool = liveSliceConfirmsFleetErrorRecovery({
      pools: data.pools,
      rowsById,
      retainedPoolIds,
      liveError: live.error,
      liveReceiptIsNewer,
    });
    const overlayError =
      live.error !== null
        ? { message: live.error.message }
        : unconfirmedPoolCount > 0
          ? {
              message: `Live health response did not confirm ${unconfirmedPoolCount} displayed pool${unconfirmedPoolCount === 1 ? "" : "s"}`,
            }
          : null;
    const inheritedError =
      liveConfirmsEveryDisplayedPool &&
      data.liveHealthErrorClearsOnLivePoll === true
        ? null
        : (data.liveHealthError ?? null);
    const liveHealthError = overlayError ?? inheritedError;
    return {
      ...data,
      liveHealthError,
      liveHealthErrorClearsOnLivePoll:
        overlayError !== null ||
        (inheritedError !== null &&
          data.liveHealthErrorClearsOnLivePoll === true),
      pools: data.pools.map((pool) => {
        const row = rowsById.get(pool.id);
        const canReplaceEqualVersion =
          liveReceiptIsNewer && !retainedPoolIds.has(pool.id);
        return row
          ? mergeLiveHealthRow(pool, row, canReplaceEqualVersion)
          : markFreshnessCheckPending(pool);
      }),
    };
  });
}

export function useLivePoolHealth(networkData: NetworkData[]): {
  networkData: NetworkData[];
  error: Error | null;
} {
  const { cache } = useSWRConfig();
  const baseReceiptSequence = fleetReceiptSequence(networkData);
  const fetcher = useCallback(async () => {
    const cachedBeforeRequest = cache.get(SWR_KEY_LIVE_POOL_HEALTH)?.data;
    const previousBeforeRequest = Array.isArray(cachedBeforeRequest)
      ? (cachedBeforeRequest as LivePoolHealthSlice[])
      : undefined;
    const current = await fetchAllLivePoolHealth(
      previousBeforeRequest,
      liveHealthBackoffUntilByNetwork,
    );
    // Read after the request finishes. If another revalidation completed while
    // this one was in flight, reconciliation must compare against that newer
    // cache value rather than the snapshot from request start.
    const cached = cache.get(SWR_KEY_LIVE_POOL_HEALTH)?.data;
    const previous = Array.isArray(cached)
      ? (cached as LivePoolHealthSlice[])
      : undefined;
    return retainLastSuccessfulLivePoolHealth(current, previous);
  }, [cache]);
  const { data, error, isLoading } = useSWR<LivePoolHealthSlice[]>(
    SWR_KEY_LIVE_POOL_HEALTH,
    fetcher,
    {
      ...SHARED_QUERY_SWR_CONFIG,
      // This is one bounded Pool query per configured chain, not the 13-way
      // snapshot fan-out. Keep focus/reconnect disabled and the request timeout
      // below this interval via fetchNetworkLivePoolHealth above.
      refreshInterval: LIVE_POOL_HEALTH_REFRESH_MS,
    },
  );
  const pending = data === undefined && error === undefined && isLoading;
  const merged = useMemo(
    () => mergeLivePoolHealth(networkData, data, pending, baseReceiptSequence),
    [networkData, data, pending, baseReceiptSequence],
  );
  const sliceError = data?.find((slice) => slice.error !== null)?.error ?? null;
  return {
    networkData: merged,
    error: error instanceof Error ? error : sliceError,
  };
}
