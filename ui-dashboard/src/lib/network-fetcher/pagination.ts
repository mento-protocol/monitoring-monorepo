import { GraphQLClient } from "graphql-request";
import * as Sentry from "@sentry/nextjs";
import {
  BROKER_DAILY_SNAPSHOTS_ALL,
  POOL_DAILY_FEE_SNAPSHOTS_PAGE,
  POOL_DAILY_SNAPSHOTS_ALL,
  UNIQUE_LP_ADDRESSES,
} from "@/lib/queries";
import type { PoolDailyFeeSnapshot, PoolSnapshotWindow } from "@/lib/types";
import { SECONDS_PER_DAY, SNAPSHOT_PAGE_SIZE } from "./constants";
import type {
  BrokerDailySnapshotRow,
  NetworkData,
  PaginatedPageResult,
  SnapshotPageResult,
} from "./types";

const SNAPSHOT_MAX_PAGES = 100;
// Per-request abort budget. Matches `homepage-og.ts` and `useBridgeGQL`. Without
// this, a wedged upstream holds the Vercel serverless function open until the
// platform timeout (10s/60s/300s) and delays TTFB on the SSR path. 5s is more
// than the p99 of the slowest query measured against Envio's hosted Hasura.
export const REQUEST_TIMEOUT_MS = 5000;

// Tracks responseKeys that have already triggered a
// "hasura-snapshot-cap-exhausted" warning so the 30s poll cycle doesn't
// re-fire the same signal on every refresh. Exported for test-scope
// `.clear()` so module state doesn't leak across tests.
/** @internal */
export const warnedCapKeys = new Set<string>();

// Throttle partial-page failures (mid-pagination exceptions). Without this,
// a persistently-flaky upstream page fires captureException every 30s poll
// cycle per chain - quota burn and noise. Keyed by ${network}:${responseKey}
// so distinct per-chain degradation still surfaces.
const PARTIAL_PAGE_THROTTLE_MS = 60_000;
/** @internal */
export const partialPageLastCapturedAt = new Map<string, number>();

/**
 * Generic paginated fetcher with Hasura fail-open behavior: hard-fail on page
 * 0, preserve and flag truncated on mid-loop failure, and log cap exhaustion
 * once per (network, responseKey). `pageSize` must match the GraphQL `limit`
 * passed by `variablesFor`; it is the short-page sentinel.
 *
 * Callers parameterize variables shape per page, response key, and a dedup key
 * extractor. Offset pagination over append-only tables is unstable under
 * concurrent inserts, so dedup is required to keep windowed totals accurate
 * even when a refresh hits mid-write.
 */
export async function fetchPaginatedRows<TRow, TVars>(args: {
  client: GraphQLClient;
  query: string;
  responseKey: string;
  network: string;
  pageSize: number;
  variablesFor: (page: number) => TVars;
  dedupKey: (row: TRow) => string;
  /** Extra payload merged into the Sentry capture for this responseKey. */
  extra?: Record<string, unknown>;
}): Promise<PaginatedPageResult<TRow>> {
  const {
    client,
    query,
    responseKey,
    network,
    pageSize,
    variablesFor,
    dedupKey,
    extra,
  } = args;
  const seen = new Set<string>();
  const rows: TRow[] = [];
  // Sequential pagination: each iteration breaks early when the page is short,
  // so batching ahead would risk unnecessary work.
  for (let page = 0; page < SNAPSHOT_MAX_PAGES; page++) {
    let batch: TRow[];
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      batch = await fetchPage({
        client,
        query,
        responseKey,
        variables: variablesFor(page),
      });
    } catch (err) {
      if (rows.length === 0) throw err;
      return partialPageResult({
        err,
        rows,
        page,
        network,
        responseKey,
        extra,
      });
    }
    appendUniqueRows(rows, seen, batch, dedupKey);
    if (batch.length < pageSize) {
      return { rows, truncated: false, error: null };
    }
  }

  capturePageCapExhaustion({ rows, network, responseKey, pageSize, extra });
  return { rows, truncated: true, error: null };
}

async function fetchPage<TRow, TVars>(args: {
  client: GraphQLClient;
  query: string;
  responseKey: string;
  variables: TVars;
}): Promise<TRow[]> {
  const result = await args.client.request<Record<string, TRow[]>>({
    document: args.query,
    variables: args.variables as Record<string, unknown>,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return result[args.responseKey] ?? [];
}

function appendUniqueRows<TRow>(
  rows: TRow[],
  seen: Set<string>,
  batch: readonly TRow[],
  dedupKey: (row: TRow) => string,
): void {
  for (const row of batch) {
    const key = dedupKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
}

function partialPageResult<TRow>(args: {
  err: unknown;
  rows: TRow[];
  page: number;
  network: string;
  responseKey: string;
  extra?: Record<string, unknown> | undefined;
}): PaginatedPageResult<TRow> {
  capturePartialPageException(args);
  return {
    rows: args.rows,
    truncated: true,
    error: args.err instanceof Error ? args.err : new Error(String(args.err)),
  };
}

function capturePartialPageException(args: {
  err: unknown;
  rows: readonly unknown[];
  page: number;
  network: string;
  responseKey: string;
  extra?: Record<string, unknown> | undefined;
}): void {
  const partialKey = `${args.network}:${args.responseKey}`;
  const now = Date.now();
  const last = partialPageLastCapturedAt.get(partialKey) ?? 0;
  if (now - last < PARTIAL_PAGE_THROTTLE_MS) return;
  partialPageLastCapturedAt.set(partialKey, now);
  Sentry.captureException(args.err, {
    tags: {
      source: "hasura",
      responseKey: args.responseKey,
      network: args.network,
      degraded: "partial-pages",
    },
    extra: { page: args.page, rowsFetched: args.rows.length, ...args.extra },
  });
}

function capturePageCapExhaustion(args: {
  rows: readonly unknown[];
  network: string;
  responseKey: string;
  pageSize: number;
  extra?: Record<string, unknown> | undefined;
}): void {
  const capKey = `${args.network}:${args.responseKey}`;
  if (!warnedCapKeys.has(capKey)) {
    warnedCapKeys.add(capKey);
    Sentry.captureMessage("hasura-snapshot-cap-exhausted", {
      level: "warning",
      tags: {
        source: "hasura",
        responseKey: args.responseKey,
        network: args.network,
      },
      extra: {
        rowsFetched: args.rows.length,
        maxPages: SNAPSHOT_MAX_PAGES,
        pageSize: args.pageSize,
        ...args.extra,
      },
    });
  }
}

// Incremental snapshot cache. Pool x day history is immutable except the
// current (and, across a midnight boundary, previous) UTC day, so after one
// successful full-history pagination we only re-fetch the mutable tail and
// merge. Module-scope on purpose: client-side it spans the SWR poll loop,
// server-side it spans ISR regenerations on a warm instance.
/** @internal Exported for test-scope `.clear()`. */
export const incrementalRowCache = new Map<
  string,
  {
    variablesKey: string;
    rows: unknown[];
    refreshAfterTimestamp: number;
    /** False for a bounded SSR seed until a full pagination succeeds. */
    complete: boolean;
  }
>();

const poolIdsVariablesKey = (poolIds: readonly string[]) =>
  [...poolIds].sort().join(",");

type IncrementalSeedArgs = {
  cacheKey: string;
  variablesKey: string;
  rows: unknown[];
  dedupKey: (row: unknown) => string;
  timestampOf: (row: unknown) => number;
  complete: boolean;
  nowMs?: number;
};

function seedIncrementalRows({
  cacheKey,
  variablesKey,
  rows,
  dedupKey,
  timestampOf,
  complete,
  nowMs = Date.now(),
}: IncrementalSeedArgs): void {
  if (rows.length === 0) return;

  const refreshAfterTimestamp = refreshAfterTimestampForRows(
    rows,
    timestampOf,
    nowMs,
  );
  const existing = incrementalRowCache.get(cacheKey);
  if (existing !== undefined && existing.variablesKey === variablesKey) {
    const mergedRows = mergeRowsPreservingExisting(
      existing.rows,
      rows,
      dedupKey,
      timestampOf,
    );
    const mergedRefreshAfterTimestamp = refreshAfterTimestampForRows(
      mergedRows,
      timestampOf,
      nowMs,
    );
    const mergedComplete = existing.complete || complete;
    if (
      existing.rows.length === mergedRows.length &&
      existing.refreshAfterTimestamp === mergedRefreshAfterTimestamp &&
      existing.complete === mergedComplete
    ) {
      return;
    }
    incrementalRowCache.set(cacheKey, {
      variablesKey,
      rows: mergedRows,
      refreshAfterTimestamp: mergedRefreshAfterTimestamp,
      // Never downgrade a full client cache when an older capped Server
      // Component fallback renders later (for example on back-navigation).
      complete: mergedComplete,
    });
    return;
  }
  if (existing !== undefined) return;
  incrementalRowCache.set(cacheKey, {
    variablesKey,
    rows,
    refreshAfterTimestamp,
    complete,
  });
}

export function seedIncrementalRowCacheFromNetworkData(
  networkData: readonly NetworkData[],
): void {
  for (const data of networkData) {
    if (
      data.snapshotsAllDailyError === null &&
      !data.snapshotsAllDailyTruncated &&
      data.pools.length > 0
    ) {
      seedIncrementalRows({
        cacheKey: `${data.network.id}:PoolDailySnapshot`,
        variablesKey: poolIdsVariablesKey(data.pools.map((pool) => pool.id)),
        rows: data.snapshotsAllDaily,
        dedupKey: (row) => {
          const snapshot = row as PoolSnapshotWindow;
          return `${snapshot.poolId}-${snapshot.timestamp}`;
        },
        timestampOf: (row) => Number((row as PoolSnapshotWindow).timestamp),
        complete: !data.snapshotsAllDailyCapped,
      });
    }

    // Fee history can heal older rows when token metadata resolves, so it keeps
    // full pagination until the source exposes a version/invalidation cursor.
  }
}

// Oldest timestamp that can still mutate: today's UTC day bucket, minus one
// extra day so a poll that crosses midnight still re-fetches the final updates
// to yesterday's row.
export function mutableDayCutoff(nowMs: number): number {
  const todayMidnightUtc =
    Math.floor(nowMs / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  return todayMidnightUtc - SECONDS_PER_DAY;
}

function refreshAfterTimestampForRows<TRow>(
  rows: readonly TRow[],
  timestampOf: (row: TRow) => number,
  nowMs: number,
): number {
  const newestIndexedTimestamp = rows.reduce(
    (newest, row) => Math.max(newest, timestampOf(row)),
    0,
  );
  return Math.min(mutableDayCutoff(nowMs), newestIndexedTimestamp);
}

function mergeRowsPreservingExisting<TRow>(
  existingRows: readonly TRow[],
  incomingRows: readonly TRow[],
  dedupKey: (row: TRow) => string,
  timestampOf: (row: TRow) => number,
): TRow[] {
  const merged = new Map<string, TRow>();
  for (const row of existingRows) merged.set(dedupKey(row), row);
  for (const row of incomingRows) {
    const key = dedupKey(row);
    if (!merged.has(key)) merged.set(key, row);
  }
  return [...merged.values()].sort(
    (a, b) =>
      timestampOf(b) - timestampOf(a) || dedupKey(b).localeCompare(dedupKey(a)),
  );
}

function mergeRowsReplacingExisting<TRow>(
  existingRows: readonly TRow[],
  incomingRows: readonly TRow[],
  dedupKey: (row: TRow) => string,
  timestampOf: (row: TRow) => number,
): TRow[] {
  const merged = new Map<string, TRow>();
  for (const row of existingRows) merged.set(dedupKey(row), row);
  for (const row of incomingRows) merged.set(dedupKey(row), row);
  return [...merged.values()].sort(
    (a, b) =>
      timestampOf(b) - timestampOf(a) || dedupKey(b).localeCompare(dedupKey(a)),
  );
}

function shouldCacheCompleteRows<TRow>(
  result: PaginatedPageResult<TRow>,
): boolean {
  return !result.truncated && result.error === null && result.rows.length > 0;
}

function surfacedIncrementalError(
  error: Error | null,
  surfaceIncrementalError: boolean,
): Error | null {
  return surfaceIncrementalError ? error : null;
}

type CompleteHistoryResult<TRow> = PaginatedPageResult<TRow> & {
  historyComplete: boolean;
};

type IncrementalBranchArgs<TRow> = {
  paginate: (afterTimestamp: number) => Promise<PaginatedPageResult<TRow>>;
  cacheKey: string;
  variablesKey: string;
  cachedRows: TRow[];
  dedupKey: (row: TRow) => string;
  timestampOf: (row: TRow) => number;
  nowMs: number;
  surfaceIncrementalError: boolean;
};

function cacheCompleteRows<TRow>(
  result: PaginatedPageResult<TRow>,
  rows: TRow[],
  args: Pick<
    IncrementalBranchArgs<TRow>,
    "cacheKey" | "variablesKey" | "timestampOf" | "nowMs"
  >,
): void {
  if (!shouldCacheCompleteRows(result)) return;
  incrementalRowCache.set(args.cacheKey, {
    variablesKey: args.variablesKey,
    rows,
    refreshAfterTimestamp: refreshAfterTimestampForRows(
      rows,
      args.timestampOf,
      args.nowMs,
    ),
    complete: true,
  });
}

async function fetchFullHistoryFromSeed<TRow>(
  args: IncrementalBranchArgs<TRow> & { hasMatchingCache: boolean },
): Promise<CompleteHistoryResult<TRow>> {
  let full: PaginatedPageResult<TRow>;
  try {
    full = await args.paginate(0);
  } catch (err) {
    if (!args.hasMatchingCache) throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      rows: args.cachedRows,
      truncated: true,
      error: surfacedIncrementalError(error, args.surfaceIncrementalError),
      historyComplete: false,
    };
  }

  const rows = args.hasMatchingCache
    ? mergeRowsReplacingExisting(
        args.cachedRows,
        full.rows,
        args.dedupKey,
        args.timestampOf,
      )
    : full.rows;
  if (
    args.hasMatchingCache &&
    full.rows.length === 0 &&
    args.cachedRows.length > 0
  ) {
    const error = new Error(
      "Full snapshot history returned no rows after a capped SSR seed",
    );
    return {
      rows: args.cachedRows,
      truncated: true,
      error: surfacedIncrementalError(error, args.surfaceIncrementalError),
      historyComplete: false,
    };
  }

  cacheCompleteRows(full, rows, args);
  return {
    ...full,
    rows,
    historyComplete: !full.truncated && full.error === null,
  };
}

async function fetchMutableHistoryTail<TRow>(
  args: IncrementalBranchArgs<TRow> & { refreshAfterTimestamp: number },
): Promise<CompleteHistoryResult<TRow>> {
  let tail: PaginatedPageResult<TRow>;
  try {
    tail = await args.paginate(args.refreshAfterTimestamp);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      rows: args.cachedRows,
      truncated: true,
      error: surfacedIncrementalError(error, args.surfaceIncrementalError),
      mutableTailError: error,
      // The immutable history remains complete; only its mutable tail is
      // stale. Keep "All" renderable with the existing partial-data signal.
      historyComplete: true,
    };
  }

  const rows = mergeRowsReplacingExisting(
    args.cachedRows,
    tail.rows,
    args.dedupKey,
    args.timestampOf,
  );
  cacheCompleteRows(tail, rows, args);
  return {
    rows,
    truncated: tail.truncated,
    error: surfacedIncrementalError(tail.error, args.surfaceIncrementalError),
    mutableTailError:
      tail.error ??
      (tail.truncated
        ? new Error("Snapshot incremental tail pagination truncated")
        : null),
    historyComplete: true,
  };
}

async function fetchPaginatedRowsIncremental<TRow, TVars>(args: {
  client: GraphQLClient;
  query: string;
  responseKey: string;
  network: string;
  pageSize: number;
  /** Serialized non-timestamp variables; a change invalidates the cache. */
  variablesKey: string;
  variablesFor: (page: number, afterTimestamp: number) => TVars;
  dedupKey: (row: TRow) => string;
  timestampOf: (row: TRow) => number;
  nowMs?: number;
  surfaceIncrementalError?: boolean;
  extra?: Record<string, unknown>;
}): Promise<CompleteHistoryResult<TRow>> {
  const {
    client,
    query,
    responseKey,
    network,
    pageSize,
    variablesKey,
    variablesFor,
    dedupKey,
    timestampOf,
    nowMs = Date.now(),
    surfaceIncrementalError = true,
    extra,
  } = args;
  const cacheKey = `${network}:${responseKey}`;
  const cached = incrementalRowCache.get(cacheKey);
  const paginate = (afterTimestamp: number) =>
    fetchPaginatedRows<TRow, TVars>({
      client,
      query,
      responseKey,
      network,
      pageSize,
      variablesFor: (page) => variablesFor(page, afterTimestamp),
      dedupKey,
      ...(extra !== undefined ? { extra } : {}),
    });

  const hasMatchingCache =
    cached !== undefined && cached.variablesKey === variablesKey;
  const cachedRows = hasMatchingCache ? (cached.rows as TRow[]) : [];
  const branchArgs: IncrementalBranchArgs<TRow> = {
    paginate,
    cacheKey,
    variablesKey,
    cachedRows,
    dedupKey,
    timestampOf,
    nowMs,
    surfaceIncrementalError,
  };

  // A bounded SSR seed is useful last-good recent data, but it is not proof
  // of complete history. Force the same from-zero pagination as a cold
  // client, then merge the result over the seed so mutable rows get the
  // fresher client value. On failure, preserve the seed and surface the
  // degraded channel instead of either losing recent data or silently
  // presenting the cap as "All".
  if (!hasMatchingCache || !cached.complete) {
    return fetchFullHistoryFromSeed({ ...branchArgs, hasMatchingCache });
  }

  return fetchMutableHistoryTail({
    ...branchArgs,
    refreshAfterTimestamp: cached.refreshAfterTimestamp,
  });
}

/**
 * Daily rollup pagination: about 365 rows per pool per year, so for typical
 * history a few pages cover everything.
 */
export async function fetchAllDailySnapshotPages(
  client: GraphQLClient,
  poolIds: string[],
  network: string,
  nowMs?: number,
): Promise<SnapshotPageResult> {
  return fetchPaginatedRowsIncremental<PoolSnapshotWindow, unknown>({
    client,
    query: POOL_DAILY_SNAPSHOTS_ALL,
    responseKey: "PoolDailySnapshot",
    network,
    pageSize: SNAPSHOT_PAGE_SIZE,
    variablesKey: poolIdsVariablesKey(poolIds),
    variablesFor: (page, afterTimestamp) => ({
      poolIds,
      afterTimestamp,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: page * SNAPSHOT_PAGE_SIZE,
    }),
    dedupKey: (s) => `${s.poolId}-${s.timestamp}`,
    timestampOf: (s) => Number(s.timestamp),
    ...(nowMs !== undefined ? { nowMs } : {}),
    extra: { poolCount: poolIds.length },
  });
}

/**
 * Paginate `BrokerDailySnapshot` rows for a chain. Rows are already filtered to
 * `routedViaV3Router=false` server-side.
 */
export async function fetchAllBrokerDailySnapshotPages(
  client: GraphQLClient,
  chainId: number,
  network: string,
): Promise<PaginatedPageResult<BrokerDailySnapshotRow>> {
  return fetchPaginatedRows<BrokerDailySnapshotRow, unknown>({
    client,
    query: BROKER_DAILY_SNAPSHOTS_ALL,
    responseKey: "BrokerDailySnapshot",
    network,
    pageSize: SNAPSHOT_PAGE_SIZE,
    variablesFor: (page) => ({
      chainId,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: page * SNAPSHOT_PAGE_SIZE,
    }),
    // The schema id `{chainId}-{provider}-{router|direct}-{day}` is canonical.
    dedupKey: (row) => row.id,
  });
}

/**
 * Paginate `LiquidityPosition` rows for a set of pool IDs, deduplicating by
 * lowercase address. One LP may hold positions in multiple pools.
 */
export async function fetchAllLpAddressPages(
  client: GraphQLClient,
  poolIds: string[],
  network: string,
): Promise<PaginatedPageResult<{ address: string }>> {
  return fetchPaginatedRows<{ address: string }, unknown>({
    client,
    query: UNIQUE_LP_ADDRESSES,
    responseKey: "LiquidityPosition",
    network,
    pageSize: SNAPSHOT_PAGE_SIZE,
    variablesFor: (page) => ({
      poolIds,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: page * SNAPSHOT_PAGE_SIZE,
    }),
    dedupKey: (r) => r.address.toLowerCase(),
    extra: { poolCount: poolIds.length },
  });
}

/**
 * Per-pool fee-snapshot pagination. Pool x day cardinality easily exceeds the
 * 1000-row cap, so we paginate and fail open like the daily snapshot path.
 */
export async function fetchAllFeeSnapshotPages(
  client: GraphQLClient,
  chainId: number,
  network: string,
): Promise<PaginatedPageResult<PoolDailyFeeSnapshot>> {
  return fetchPaginatedRows<PoolDailyFeeSnapshot, unknown>({
    client,
    query: POOL_DAILY_FEE_SNAPSHOTS_PAGE,
    responseKey: "PoolDailyFeeSnapshot",
    network,
    pageSize: SNAPSHOT_PAGE_SIZE,
    variablesFor: (page) => ({
      chainId,
      afterTimestamp: 0,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: page * SNAPSHOT_PAGE_SIZE,
    }),
    dedupKey: (s) => s.id,
  });
}
