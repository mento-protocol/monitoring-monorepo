// Server-safe GraphQL fetcher shared by the React hook
// (`@/hooks/use-all-networks-data`) and Server Components that need to
// pre-render the dashboard payload. Deliberately avoids any React / SWR
// imports so it can run in both runtimes without tripping Next.js's RSC
// swr/react-server bundling (which has no default export).

import { GraphQLClient } from "graphql-request";
import * as Sentry from "@sentry/nextjs";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import type { Network } from "@/lib/networks";
import {
  ALL_POOLS_BREACH_ROLLUP,
  ALL_POOLS_WITH_HEALTH,
  ALL_TRADING_LIMITS,
  ALL_OLS_POOLS,
  POOL_DAILY_SNAPSHOTS_ALL,
  PROTOCOL_FEE_TRANSFERS_ALL,
  UNIQUE_LP_ADDRESSES,
} from "@/lib/queries";
import {
  aggregateProtocolFees,
  type ProtocolFeeSummary,
} from "@/lib/protocol-fees";
import {
  buildSnapshotWindows,
  filterSnapshotsToWindow,
  shouldQueryPoolSnapshots,
  type SnapshotWindows,
  type TimeRange,
} from "@/lib/volume";
import type {
  Pool,
  PoolSnapshotWindow,
  ProtocolFeeTransfer,
  TradingLimit,
  OlsPool,
} from "@/lib/types";
import { isFpmm, buildOracleRateMap, type OracleRateMap } from "@/lib/tokens";

export type NetworkData = {
  network: Network;
  snapshotWindows: SnapshotWindows;
  pools: Pool[];
  /**
   * Windowed snapshot arrays derived client-side by filtering
   * `snapshotsAllDaily` with UTC-midnight-anchored bounds. The source is the
   * daily rollup (one row per pool per UTC day), so each window contains
   * exactly 1/7/30 potential daily rows — no overcounting across UTC-day
   * boundaries. Intra-day precision is sacrificed; KPI tiles show UTC-day-
   * aligned totals.
   *
   * Per-window error fields below are only set when that window's coverage
   * is incomplete (i.e., we didn't paginate back far enough).
   */
  snapshots: PoolSnapshotWindow[];
  snapshots7d: PoolSnapshotWindow[];
  snapshots30d: PoolSnapshotWindow[];
  /**
   * Full-history daily rollup snapshots, one row per pool per UTC day.
   * Feeds both the TVL and Volume charts. At ~365 rows/pool/year a few pages
   * cover everything — this replaced the old hourly `snapshotsAll` fetch
   * whose ~8760 rows/pool/year × multi-chain fan-out routinely tripped the
   * Envio tier quota (429).
   */
  snapshotsAllDaily: PoolSnapshotWindow[];
  /** True when the daily pagination loop hit its safety cap. */
  snapshotsAllDailyTruncated: boolean;
  tradingLimits: TradingLimit[];
  olsPoolIds: Set<string>;
  fees: ProtocolFeeSummary | null;
  /** Raw fee transfer rows — kept for time-series bucketing on the revenue page. */
  feeTransfers: ProtocolFeeTransfer[];
  uniqueLpAddresses: string[] | null;
  rates: OracleRateMap;
  error: Error | null;
  feesError: Error | null;
  /**
   * Per-window snapshot errors. A window only gets an error when the
   * pagination failure / truncation actually affects that window — i.e.,
   * we didn't fetch rows going back as far as the window's lower bound.
   */
  snapshotsError: Error | null;
  snapshots7dError: Error | null;
  snapshots30dError: Error | null;
  /** Error on the paginated all-history daily fetch. */
  snapshotsAllDailyError: Error | null;
  lpError: Error | null;
};

/**
 * Zero-default `NetworkData` shell. Exported so slim hooks (e.g.
 * `useProtocolFees`) can produce a `NetworkData[]`-shaped payload with
 * only the fields they populate, rather than redeclaring the 20-field
 * blank template. `overrides` lets a caller drop fees/rates/etc. in.
 */
export const blankNetworkData = (
  network: Network,
  snapshotWindows: SnapshotWindows,
  overrides: Partial<NetworkData> = {},
): NetworkData => ({
  network,
  snapshotWindows,
  pools: [],
  snapshots: [],
  snapshots7d: [],
  snapshots30d: [],
  snapshotsAllDaily: [],
  snapshotsAllDailyTruncated: false,
  tradingLimits: [],
  olsPoolIds: new Set(),
  fees: null,
  feeTransfers: [],
  uniqueLpAddresses: null,
  rates: new Map(),
  error: null,
  feesError: null,
  snapshotsError: null,
  snapshots7dError: null,
  snapshots30dError: null,
  snapshotsAllDailyError: null,
  lpError: null,
  ...overrides,
});

const emptyNetworkData = (
  network: Network,
  snapshotWindows: SnapshotWindows,
  error: Error,
): NetworkData => blankNetworkData(network, snapshotWindows, { error });

/**
 * Envio's hosted Hasura silently caps every query at 1000 rows regardless of
 * the `limit` we send, so for full history we paginate with offset. Stop as
 * soon as a page comes back under the page size (that's the last page). We
 * only paginate the daily rollup (PoolDailySnapshot) — at ~365 rows/pool/year
 * a few pages cover years of history for typical pool counts.
 *
 * Failure modes, all designed to fail open rather than blank the dashboard:
 * - Safety cap `SNAPSHOT_MAX_PAGES` reached → return accumulated rows with
 *   `truncated: true, error: null`. Since rows are ordered newest-first, the
 *   missing rows are the oldest ones, so 24h/7d/30d windows stay correct.
 *   No `error` because this is an intentional safety cap, not a fault.
 * - Mid-loop request error AFTER some pages succeeded → keep what we have,
 *   flag `truncated: true` AND set `error` so error-aware consumers (e.g.
 *   the Summary Volume tile) partial-badge correctly. Without the error
 *   signal the degraded state would be invisible to anything that only
 *   checks the error channel.
 * - First-page failure → rethrow. No rows at all means there's nothing to
 *   salvage; the caller surfaces it as `snapshotsAllDailyError` (empty state
 *   with explicit error message, not a misleading `$0` dashboard).
 *
 * Dedup: offset pagination on an append-only table isn't stable under
 * concurrent inserts — a new snapshot at position 0 shifts everything one
 * row right, so the next page's offset overlaps with the previous page's
 * tail. We dedup by `(poolId, timestamp)` (which uniquely identifies a
 * snapshot per the indexer's daily-bucket upsert id) before pushing into the
 * result. This mitigates duplicates; omissions are still theoretically
 * possible but rare and self-heal on the next refresh. A proper fix is
 * keyset pagination — tracked as a follow-up.
 */
const SNAPSHOT_PAGE_SIZE = 1000;
const SNAPSHOT_MAX_PAGES = 100;

export type SnapshotPageResult = {
  rows: PoolSnapshotWindow[];
  truncated: boolean;
  error: Error | null;
};

const snapshotDedupKey = (s: PoolSnapshotWindow) =>
  `${s.poolId}-${s.timestamp}`;

// Tracks responseKeys that have already triggered a
// "hasura-snapshot-cap-exhausted" warning so the 30s poll cycle doesn't
// re-fire the same signal on every refresh. Exported for test-scope
// `.clear()` so module state doesn't leak across tests.
/** @internal */
export const warnedCapKeys = new Set<string>();

// Throttle partial-page failures (mid-pagination exceptions). Without this,
// a persistently-flaky upstream page fires captureException every 30s poll
// cycle per chain — quota burn and noise. Keyed by ${network}:${responseKey}
// so distinct per-chain degradation still surfaces.
const PARTIAL_PAGE_THROTTLE_MS = 60_000;
/** @internal */
export const partialPageLastCapturedAt = new Map<string, number>();

/**
 * Daily rollup pagination — ~365 rows/pool/year, so for typical history a
 * few pages cover everything. Uses the fail-open semantics documented on
 * `SNAPSHOT_PAGE_SIZE`.
 */
async function fetchAllDailySnapshotPages(
  client: GraphQLClient,
  poolIds: string[],
  network: string,
): Promise<SnapshotPageResult> {
  return fetchPaginatedSnapshotPages(
    client,
    poolIds,
    POOL_DAILY_SNAPSHOTS_ALL,
    "PoolDailySnapshot",
    network,
  );
}

async function fetchPaginatedSnapshotPages<K extends string>(
  client: GraphQLClient,
  poolIds: string[],
  query: string,
  responseKey: K,
  network: string,
): Promise<SnapshotPageResult> {
  const seen = new Set<string>();
  const rows: PoolSnapshotWindow[] = [];
  for (let page = 0; page < SNAPSHOT_MAX_PAGES; page++) {
    let batch: PoolSnapshotWindow[];
    try {
      const result = await client.request<Record<K, PoolSnapshotWindow[]>>(
        query,
        {
          poolIds,
          limit: SNAPSHOT_PAGE_SIZE,
          offset: page * SNAPSHOT_PAGE_SIZE,
        },
      );
      batch = result[responseKey] ?? [];
    } catch (err) {
      // First-page failure is a hard error — nothing to degrade to.
      if (rows.length === 0) throw err;
      // Otherwise preserve the pages we did fetch; surface error AND flag
      // truncation so consumers know the data is partial. Report to Sentry
      // so partial-data degradation isn't silent — but throttle per
      // network+responseKey so the 30s poll loop can't fan out a storm.
      const partialKey = `${network}:${responseKey}`;
      const now = Date.now();
      const last = partialPageLastCapturedAt.get(partialKey) ?? 0;
      if (now - last >= PARTIAL_PAGE_THROTTLE_MS) {
        partialPageLastCapturedAt.set(partialKey, now);
        Sentry.captureException(err, {
          tags: {
            source: "hasura",
            responseKey,
            network,
            degraded: "partial-pages",
          },
          extra: { page, rowsFetched: rows.length, poolCount: poolIds.length },
        });
      }
      return {
        rows,
        truncated: true,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    for (const row of batch) {
      const key = snapshotDedupKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (batch.length < SNAPSHOT_PAGE_SIZE) {
      return { rows, truncated: false, error: null };
    }
  }
  // Safety-cap exhaustion: we fetched SNAPSHOT_MAX_PAGES × SNAPSHOT_PAGE_SIZE
  // rows without running out. Data is genuinely incomplete — flag as a warning
  // so we can tell when the cap needs raising (or when indexer rollups need
  // replacing a paginated fetch). Dedup key is `${network}:${responseKey}` so
  // each chain surfaces its own cap event once (not once total across chains).
  const capKey = `${network}:${responseKey}`;
  if (!warnedCapKeys.has(capKey)) {
    warnedCapKeys.add(capKey);
    Sentry.captureMessage("hasura-snapshot-cap-exhausted", {
      level: "warning",
      tags: { source: "hasura", responseKey, network },
      extra: {
        rowsFetched: rows.length,
        poolCount: poolIds.length,
        maxPages: SNAPSHOT_MAX_PAGES,
        pageSize: SNAPSHOT_PAGE_SIZE,
      },
    });
  }
  return { rows, truncated: true, error: null };
}

/** @internal Exported for testing only. */
export async function fetchNetworkData(
  network: Network,
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange },
): Promise<NetworkData> {
  const client = new GraphQLClient(network.hasuraUrl);

  let pools: Pool[];
  try {
    const poolsRes = await client.request<{ Pool: Pool[] }>(
      ALL_POOLS_WITH_HEALTH,
      { chainId: network.chainId },
    );
    pools = poolsRes.Pool ?? [];
  } catch (err) {
    return emptyNetworkData(
      network,
      windows,
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  const poolIds = pools.map((p) => p.id);
  const fpmmPoolIds = pools.filter(isFpmm).map((p) => p.id);
  const shouldQuery = shouldQueryPoolSnapshots(poolIds);

  const emptySnapshotPage: SnapshotPageResult = {
    rows: [],
    truncated: false,
    error: null,
  };
  const [
    feesResult,
    snapshotsAllDailyResult,
    lpResult,
    tradingLimitsResult,
    olsResult,
    breachRollupResult,
  ] = await Promise.allSettled([
    client.request<{ ProtocolFeeTransfer: ProtocolFeeTransfer[] }>(
      PROTOCOL_FEE_TRANSFERS_ALL,
      { chainId: network.chainId },
    ),
    shouldQuery
      ? fetchAllDailySnapshotPages(client, poolIds, network.id)
      : Promise.resolve(emptySnapshotPage),
    fpmmPoolIds.length > 0
      ? client.request<{
          LiquidityPosition: { address: string }[];
        }>(UNIQUE_LP_ADDRESSES, { poolIds: fpmmPoolIds })
      : Promise.resolve({
          LiquidityPosition: [] as { address: string }[],
        }),
    client.request<{ TradingLimit: TradingLimit[] }>(ALL_TRADING_LIMITS, {
      chainId: network.chainId,
    }),
    client.request<{ OlsPool: Pick<OlsPool, "poolId">[] }>(ALL_OLS_POOLS, {
      chainId: network.chainId,
    }),
    // Uptime rollup — isolated from ALL_POOLS_WITH_HEALTH so a schema-
    // lag fail degrades just the uptime column to "—", not the entire
    // pools page.
    client.request<{
      Pool: {
        id: string;
        cumulativeCriticalSeconds?: string;
        breachCount?: number;
      }[];
    }>(ALL_POOLS_BREACH_ROLLUP, { chainId: network.chainId }),
  ]);

  // Merge the rollup fields into the pool objects. On failure (including
  // the phased-rollout "field not found" window) we leave the fields
  // undefined and the uptime column falls back to "—".
  if (breachRollupResult.status === "fulfilled") {
    const rollupById = new Map(
      (breachRollupResult.value.Pool ?? []).map((r) => [r.id, r]),
    );
    pools = pools.map((p) => {
      const r = rollupById.get(p.id);
      return r == null
        ? p
        : {
            ...p,
            cumulativeCriticalSeconds: r.cumulativeCriticalSeconds,
            breachCount: r.breachCount,
          };
    });
  }

  const toError = (reason: unknown) =>
    reason instanceof Error ? reason : new Error(String(reason));

  const rates = buildOracleRateMap(pools, network);

  const fees =
    feesResult.status === "fulfilled"
      ? aggregateProtocolFees(feesResult.value.ProtocolFeeTransfer ?? [], rates)
      : null;

  // Single source of truth: the paginated daily-rollup fetch. Window-specific
  // arrays are derived in-memory — no separate requests, no server-side cap.
  // If pagination truncated (hit MAX_PAGES or mid-loop fetch failure) we keep
  // the most-recent rows we did fetch: 24h/7d/30d derive correctly from those
  // and "All" is flagged as partial.
  const snapshotsAllDaily =
    snapshotsAllDailyResult.status === "fulfilled"
      ? snapshotsAllDailyResult.value.rows
      : [];
  const snapshotsAllDailyTruncated =
    snapshotsAllDailyResult.status === "fulfilled"
      ? snapshotsAllDailyResult.value.truncated
      : false;
  const snapshotsAllDailyError =
    snapshotsAllDailyResult.status === "rejected"
      ? toError(snapshotsAllDailyResult.reason)
      : (snapshotsAllDailyResult.value.error ?? null);

  // PoolDailySnapshot rows are UTC-midnight-aligned incremental aggregates
  // (one row per pool per UTC day). Anchoring on today's UTC midnight gives
  // exactly 1/7/30 daily rows per KPI window without overcounting.
  //
  // `windows.w24h.to` is the caller's snapshot of "now", so deriving
  // todayMidnight from it keeps all three windows consistent with the same
  // clock tick rather than calling Date.now() again.
  const SECS_PER_DAY = 86400;
  const todayMidnight =
    Math.floor(windows.w24h.to / SECS_PER_DAY) * SECS_PER_DAY;
  const dw24h: TimeRange = {
    from: todayMidnight,
    to: todayMidnight + SECS_PER_DAY,
  };
  const dw7d: TimeRange = {
    from: todayMidnight - 6 * SECS_PER_DAY,
    to: todayMidnight + SECS_PER_DAY,
  };
  const dw30d: TimeRange = {
    from: todayMidnight - 29 * SECS_PER_DAY,
    to: todayMidnight + SECS_PER_DAY,
  };

  const snapshots = filterSnapshotsToWindow(snapshotsAllDaily, dw24h);
  const snapshots7d = filterSnapshotsToWindow(snapshotsAllDaily, dw7d);
  const snapshots30d = filterSnapshotsToWindow(snapshotsAllDaily, dw30d);

  // Per-window error detection. Pagination issues (error or truncation) only
  // affect a specific window if we didn't fetch far enough back to cover its
  // `from` bound. With a mid-loop failure after page 1 (~1000 most-recent
  // daily rows ≈ 2.7 years per pool) the 24h/7d/30d windows remain fully
  // covered. Rows come in newest-first, so the last element is the oldest
  // we fetched.
  const oldestFetchedTs =
    snapshotsAllDaily.length > 0
      ? Number(snapshotsAllDaily[snapshotsAllDaily.length - 1].timestamp)
      : Number.POSITIVE_INFINITY;
  const paginationIssue: Error | null =
    snapshotsAllDailyError ??
    (snapshotsAllDailyTruncated
      ? new Error(
          "Snapshot pagination truncated before reaching the requested window",
        )
      : null);
  const windowError = (windowFrom: number): Error | null =>
    paginationIssue !== null && oldestFetchedTs > windowFrom
      ? paginationIssue
      : null;
  const snapshotsError = windowError(dw24h.from);
  const snapshots7dError = windowError(dw7d.from);
  const snapshots30dError = windowError(dw30d.from);

  const uniqueLpAddresses =
    lpResult.status === "fulfilled"
      ? Array.from(
          new Set(
            // Lowercase before dedup: upstream rows can arrive in mixed casing
            // (checksum on some sources, lowercase on others) and Set keys on
            // raw strings would count the same wallet twice.
            (lpResult.value.LiquidityPosition ?? []).map((lp) =>
              lp.address.toLowerCase(),
            ),
          ),
        )
      : null;

  const tradingLimits =
    tradingLimitsResult.status === "fulfilled"
      ? (tradingLimitsResult.value.TradingLimit ?? [])
      : [];

  const olsPoolIds =
    olsResult.status === "fulfilled"
      ? new Set((olsResult.value.OlsPool ?? []).map((p) => p.poolId))
      : new Set<string>();

  return {
    network,
    snapshotWindows: windows,
    pools,
    snapshots,
    snapshots7d,
    snapshots30d,
    snapshotsAllDaily,
    snapshotsAllDailyTruncated,
    tradingLimits,
    olsPoolIds,
    fees,
    feeTransfers:
      feesResult.status === "fulfilled"
        ? (feesResult.value.ProtocolFeeTransfer ?? [])
        : [],
    uniqueLpAddresses,
    rates,
    error: null,
    feesError:
      feesResult.status === "rejected" ? toError(feesResult.reason) : null,
    // Per-window errors — only set when the specific window is incomplete.
    // See the `windowError` helper above.
    snapshotsError,
    snapshots7dError,
    snapshots30dError,
    snapshotsAllDailyError,
    lpError: lpResult.status === "rejected" ? toError(lpResult.reason) : null,
  };
}

/**
 * Fetches pools, full-history daily snapshots (paginated), protocol fees, and
 * LP counts for ALL configured networks in parallel. Window-specific snapshot
 * arrays (24h/7d/30d) are derived in-memory from `snapshotsAllDaily` so we
 * make one paginated request instead of four overlapping ones, and avoid
 * Hasura's silent 1000-row cap on windowed queries. Uses Promise.allSettled
 * so one failing network doesn't block others.
 */
export async function fetchAllNetworks(): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const now = Date.now();
  const windows = buildSnapshotWindows(now);

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) => fetchNetworkData(NETWORKS[id], windows)),
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return emptyNetworkData(
      NETWORKS[configuredNetworkIds[i]],
      windows,
      result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason)),
    );
  });
}
