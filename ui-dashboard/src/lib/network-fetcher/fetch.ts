// Server-safe GraphQL fetcher shared by the React hook
// (`@/hooks/use-all-networks-data`) and Server Components that need to
// pre-render the dashboard payload. Deliberately avoids any React / SWR
// imports so it can run in both runtimes without tripping Next.js's RSC
// swr/react-server bundling (which has no default export). Module-scope
// state (`warnedCapKeys`, `partialPageLastCapturedAt`) intentionally
// persists across requests to throttle Sentry signals across the 30s poll
// loop; tests `.clear()` these to reset between cases.

import { GraphQLClient } from "graphql-request";
import * as Sentry from "@sentry/nextjs";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import type { Network } from "@/lib/networks";
import {
  ALL_POOLS_BREACH_ROLLUP,
  ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN,
  ALL_POOLS_WITH_HEALTH,
  ALL_TRADING_LIMITS,
  ALL_OLS_POOLS,
  BROKER_DAILY_SNAPSHOTS_ALL,
  POOL_DAILY_FEE_SNAPSHOTS_PAGE,
  POOL_DAILY_SNAPSHOTS_ALL,
  UNIQUE_LP_ADDRESSES,
} from "@/lib/queries";
import { aggregateProtocolFees } from "@/lib/protocol-fees";
import { detectProbedStrategies } from "@/lib/strategy-detection";
import {
  buildSnapshotWindows,
  filterSnapshotsToWindow,
  shouldQueryPoolSnapshots,
  type SnapshotWindows,
  type TimeRange,
} from "@/lib/volume";
import type {
  Pool,
  PoolDailyFeeSnapshot,
  PoolSnapshotWindow,
  TradingLimit,
  OlsPool,
} from "@/lib/types";
import { isFpmm, buildOracleRateMap } from "@/lib/tokens";
import type {
  BrokerDailySnapshotRow,
  NetworkData,
  PaginatedPageResult,
  SnapshotPageResult,
} from "./types";

/**
 * True iff every error channel on `n` is null — top-level, rates,
 * fee snapshots, per-window snapshots, all-history daily, broker daily,
 * and LP. Used to decide whether an SSR-seeded payload is fresh enough
 * to skip client-side revalidation; any per-slice failure on the server
 * would otherwise trap the user on partial `N/A` metrics until the next
 * poll.
 *
 * Truncation flags (`feeSnapshotsTruncated`, `snapshotsAllDailyTruncated`,
 * `brokerSnapshotsAllDailyTruncated`) are intentionally excluded — they
 * represent a permanent cap-exhaustion state until `SNAPSHOT_MAX_PAGES`
 * is raised. Including them would force perpetual mount-time revalidation
 * that can never recover. The UI surfaces truncation via the `≈` prefix
 * + subtitle; this gate is for transient errors only.
 */
export function isNetworkDataFullyHealthy(n: NetworkData): boolean {
  return (
    n.error === null &&
    n.ratesError === null &&
    n.feeSnapshotsError === null &&
    n.snapshotsError === null &&
    n.snapshots7dError === null &&
    n.snapshots30dError === null &&
    n.snapshotsAllDailyError === null &&
    n.brokerSnapshotsAllDailyError === null &&
    n.lpError === null
  );
}

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
  brokerSnapshotsAllDaily: [],
  brokerSnapshotsAllDailyTruncated: false,
  tradingLimits: [],
  olsPoolIds: new Set(),
  cdpPoolIds: new Set(),
  reservePoolIds: new Set(),
  fees: null,
  feeSnapshots: [],
  feeSnapshotsError: null,
  feeSnapshotsTruncated: false,
  ratesError: null,
  poolLabels: new Map(),
  uniqueLpAddresses: null,
  rates: new Map(),
  error: null,
  snapshotsError: null,
  snapshots7dError: null,
  snapshots30dError: null,
  snapshotsAllDailyError: null,
  brokerSnapshotsAllDailyError: null,
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
// cycle per chain — quota burn and noise. Keyed by ${network}:${responseKey}
// so distinct per-chain degradation still surfaces.
const PARTIAL_PAGE_THROTTLE_MS = 60_000;
/** @internal */
export const partialPageLastCapturedAt = new Map<string, number>();

/**
 * Generic paginated fetcher with the Hasura fail-open contract documented on
 * `SNAPSHOT_PAGE_SIZE`: hard-fail on page 0, preserve and flag truncated on
 * mid-loop failure, log cap exhaustion once per (network, responseKey).
 *
 * Callers parameterize: variables shape per page, response key, and a dedup
 * key extractor — offset pagination over an append-only table is unstable
 * under concurrent inserts, so dedup is required to keep windowed totals
 * accurate even when a refresh hits mid-write.
 */
async function fetchPaginatedRows<TRow, TVars>(args: {
  client: GraphQLClient;
  query: string;
  responseKey: string;
  network: string;
  variablesFor: (page: number) => TVars;
  dedupKey: (row: TRow) => string;
  /** Extra payload merged into the Sentry capture for this responseKey. */
  extra?: Record<string, unknown>;
}): Promise<PaginatedPageResult<TRow>> {
  const { client, query, responseKey, network, variablesFor, dedupKey, extra } =
    args;
  const seen = new Set<string>();
  const rows: TRow[] = [];
  // Sequential pagination — each iteration breaks early when the page
  // is short, so we can't batch ahead without risking unnecessary work.
  for (let page = 0; page < SNAPSHOT_MAX_PAGES; page++) {
    let batch: TRow[];
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await client.request<Record<string, TRow[]>>({
        document: query,
        variables: variablesFor(page) as Record<string, unknown>,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      batch = result[responseKey] ?? [];
    } catch (err) {
      if (rows.length === 0) throw err;
      // Mid-loop failure → preserve fetched pages, flag truncated, throttle
      // Sentry per (network, responseKey) so the 30s poll can't fan out a storm.
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
          extra: { page, rowsFetched: rows.length, ...extra },
        });
      }
      return {
        rows,
        truncated: true,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    for (const row of batch) {
      const key = dedupKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (batch.length < SNAPSHOT_PAGE_SIZE) {
      return { rows, truncated: false, error: null };
    }
  }
  // Cap exhaustion: data is genuinely incomplete. One Sentry message per
  // (network, responseKey) pair — each chain surfaces its own cap event once.
  const capKey = `${network}:${responseKey}`;
  if (!warnedCapKeys.has(capKey)) {
    warnedCapKeys.add(capKey);
    Sentry.captureMessage("hasura-snapshot-cap-exhausted", {
      level: "warning",
      tags: { source: "hasura", responseKey, network },
      extra: {
        rowsFetched: rows.length,
        maxPages: SNAPSHOT_MAX_PAGES,
        pageSize: SNAPSHOT_PAGE_SIZE,
        ...extra,
      },
    });
  }
  return { rows, truncated: true, error: null };
}

/**
 * Daily rollup pagination — ~365 rows/pool/year, so for typical history a
 * few pages cover everything.
 */
async function fetchAllDailySnapshotPages(
  client: GraphQLClient,
  poolIds: string[],
  network: string,
): Promise<SnapshotPageResult> {
  return fetchPaginatedRows<PoolSnapshotWindow, unknown>({
    client,
    query: POOL_DAILY_SNAPSHOTS_ALL,
    responseKey: "PoolDailySnapshot",
    network,
    variablesFor: (page) => ({
      poolIds,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: page * SNAPSHOT_PAGE_SIZE,
    }),
    dedupKey: (s) => `${s.poolId}-${s.timestamp}`,
    extra: { poolCount: poolIds.length },
  });
}

/**
 * Paginate `BrokerDailySnapshot` rows for a chain — already filtered to
 * `routedViaV3Router=false` server-side. Row count grows as
 * `(daily_distinct_providers × days)`, so a single chain stays under the
 * 1000-row Hasura cap for years; pagination is here for safety.
 */
async function fetchAllBrokerDailySnapshotPages(
  client: GraphQLClient,
  chainId: number,
  network: string,
): Promise<PaginatedPageResult<BrokerDailySnapshotRow>> {
  return fetchPaginatedRows<BrokerDailySnapshotRow, unknown>({
    client,
    query: BROKER_DAILY_SNAPSHOTS_ALL,
    responseKey: "BrokerDailySnapshot",
    network,
    variablesFor: (page) => ({
      chainId,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: page * SNAPSHOT_PAGE_SIZE,
    }),
    // The schema id `{chainId}-{provider}-{router|direct}-{day}` is the
    // canonical row key — required because two providers can share the same
    // (timestamp, volumeUsdWei, swapCount) tuple at low traffic.
    dedupKey: (row) => row.id,
  });
}

/**
 * Per-pool fee-snapshot pagination — pool×day cardinality (~30 pools × ~430
 * days) easily exceeds the 1000-row cap, so we paginate. Same fail-open
 * semantics as the daily snapshot path. Dedup keyed off `id` since
 * `PoolDailyFeeSnapshot.id = "{chainId}-{poolAddress}-{dayTs}"` is unique by
 * construction. Exported because the slim `useProtocolFees` hook fetches its
 * own snapshots — the homepage path in `fetchNetworkData` doesn't render the
 * leaderboard so it leaves `feeSnapshots` empty.
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
    variablesFor: (page) => ({
      chainId,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: page * SNAPSHOT_PAGE_SIZE,
    }),
    dedupKey: (s) => s.id,
  });
}

/** @internal Exported for testing only. */
export async function fetchNetworkData(
  network: Network,
  windows: { w24h: TimeRange; w7d: TimeRange; w30d: TimeRange },
): Promise<NetworkData> {
  const client = new GraphQLClient(network.hasuraUrl);

  // Helper to bind a per-request AbortSignal.timeout without repeating the
  // object-form at every call site. Re-binds on every invocation so each
  // request gets its own timer (a shared signal would abort the rest of
  // the parallel batch when any single request exceeded the budget).
  const timed = <T>(document: string, variables?: Record<string, unknown>) =>
    client.request<T>({
      document,
      variables,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let pools: Pool[];
  try {
    const poolsRes = await timed<{ Pool: Pool[] }>(ALL_POOLS_WITH_HEALTH, {
      chainId: network.chainId,
    });
    pools = poolsRes.Pool ?? [];
  } catch (err) {
    return emptyNetworkData(
      network,
      windows,
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  const poolIds = pools.map((p) => p.id);
  const fpmmPoolIds = pools.flatMap((p) => (isFpmm(p) ? [p.id] : []));
  const shouldQuery = shouldQueryPoolSnapshots(poolIds);

  const emptySnapshotPage: SnapshotPageResult = {
    rows: [],
    truncated: false,
    error: null,
  };
  const [
    feeSnapshotsResult,
    snapshotsAllDailyResult,
    brokerSnapshotsAllDailyResult,
    lpResult,
    tradingLimitsResult,
    olsResult,
    breachRollupResult,
    rebalanceThresholdsKnownResult,
    cdpPoolIdsResult,
  ] = await Promise.allSettled([
    fetchAllFeeSnapshotPages(client, network.chainId, network.id),
    shouldQuery
      ? fetchAllDailySnapshotPages(client, poolIds, network.id)
      : Promise.resolve(emptySnapshotPage),
    // Legacy v2 daily volume rollup (Broker.Swap with `routedViaV3Router=false`).
    // Filtered server-side by chainId — only Celo has a Broker today, but
    // querying on every chain is harmless (Monad simply returns 0 rows).
    fetchAllBrokerDailySnapshotPages(client, network.chainId, network.id),
    fpmmPoolIds.length > 0
      ? timed<{ LiquidityPosition: { address: string }[] }>(
          UNIQUE_LP_ADDRESSES,
          { poolIds: fpmmPoolIds },
        )
      : Promise.resolve({
          LiquidityPosition: [] as { address: string }[],
        }),
    timed<{ TradingLimit: TradingLimit[] }>(ALL_TRADING_LIMITS, {
      chainId: network.chainId,
    }),
    timed<{ OlsPool: Pick<OlsPool, "poolId">[] }>(ALL_OLS_POOLS, {
      chainId: network.chainId,
    }),
    // Uptime rollup — isolated from ALL_POOLS_WITH_HEALTH so a schema-
    // lag fail degrades just the uptime column to "—", not the entire
    // pools page.
    timed<{
      Pool: {
        id: string;
        breachCount?: number;
        healthBinarySeconds?: string;
        healthTotalSeconds?: string;
      }[];
    }>(ALL_POOLS_BREACH_ROLLUP, { chainId: network.chainId }),
    // Data-trust flags (`rebalanceThresholdsKnown` triple +
    // `tokenDecimalsKnown`) — isolated for the same schema-lag reason as
    // the breach rollup above. Consumers degrade safely when the fields
    // are missing: thresholds fall back to the 10000-bps under-bound;
    // USD math via `getSnapshotVolumeInUsd` returns null and the volume
    // column shows "—" rather than a 6-dp-USDC-as-18-dp scaled lie.
    // Split-side fields included because `isNeverRebalance` needs BOTH
    // above/below to be 0.
    timed<{
      Pool: {
        id: string;
        rebalanceThresholdAbove?: number;
        rebalanceThresholdBelow?: number;
        rebalanceThresholdsKnown?: boolean;
        tokenDecimalsKnown?: boolean;
      }[];
    }>(ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN, { chainId: network.chainId }),
    // RPC probe — no indexer entity for CDP strategy, so we detect by
    // calling `getCDPConfig` on each unique rebalancer contract. Cached at
    // module scope so the cost is ~1 call per deployed strategy per TTL.
    detectProbedStrategies(network, pools),
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
            breachCount: r.breachCount,
            healthBinarySeconds: r.healthBinarySeconds,
            // BOTH fields come from the rollup so the numerator/denominator
            // pair is a same-query snapshot — no falling back to
            // ALL_POOLS_WITH_HEALTH's `healthTotalSeconds`, which would
            // pair counters captured at different polling cycles.
            healthTotalSeconds: r.healthTotalSeconds,
          };
    });
  }

  // Merge data-trust flags into the pool objects. On failure (schema-
  // lag during deploy), the fields stay `undefined` and
  // `isNeverRebalance` / `effectiveThreshold` fall back to the safe
  // 10000-bps under-bound; `getSnapshotVolumeInUsd` returns null
  // when `tokenDecimalsKnown` is undefined-or-false so untrusted-decimal
  // pools don't fake a USD volume from schema-default 18/18.
  if (rebalanceThresholdsKnownResult.status === "fulfilled") {
    const knownById = new Map(
      (rebalanceThresholdsKnownResult.value.Pool ?? []).map((r) => [r.id, r]),
    );
    pools = pools.map((p) => {
      const r = knownById.get(p.id);
      return r == null
        ? p
        : {
            ...p,
            rebalanceThresholdAbove: r.rebalanceThresholdAbove,
            rebalanceThresholdBelow: r.rebalanceThresholdBelow,
            rebalanceThresholdsKnown: r.rebalanceThresholdsKnown,
            tokenDecimalsKnown: r.tokenDecimalsKnown,
          };
    });
  }

  const toError = (reason: unknown) =>
    reason instanceof Error ? reason : new Error(String(reason));

  const rates = buildOracleRateMap(pools, network);

  const feeSnapshots =
    feeSnapshotsResult.status === "fulfilled"
      ? feeSnapshotsResult.value.rows
      : [];
  const feeSnapshotsError =
    feeSnapshotsResult.status === "rejected"
      ? toError(feeSnapshotsResult.reason)
      : (feeSnapshotsResult.value.error ?? null);
  // Cap-exhaustion: helper returns `truncated: true, error: null`. We still
  // aggregate from the rows we did fetch; consumers gate on this flag to
  // mark the all-time total approximate.
  const feeSnapshotsTruncated =
    feeSnapshotsResult.status === "fulfilled" &&
    feeSnapshotsResult.value.truncated;
  // Rates failure on the homepage SSR path: rates are derived from `pools`
  // (no separate query), so a query-level rates failure already early-
  // returned via the `pools` catch above. The remaining failure mode is
  // `buildOracleRateMap` returning an empty map even when `pools` has
  // rows — i.e., every oracle pool has `oracleOk: false` or no oracle
  // pools exist on this chain. That silently mis-prices FX-token slots
  // in `aggregateProtocolFees` since `tokenToUSD` returns null for
  // unknown symbols and only USD-pegged tokens contribute. Match the
  // hook's fail-loud invariant: if we expected rates and got none, set
  // `ratesError` so consumers blank the tile rather than render a
  // confidently-wrong (understated) total.
  const ssrRatesError =
    pools.length > 0 && rates.size === 0
      ? new Error(
          `Oracle rates unavailable for ${network.label} — FX-token fees can't be priced`,
        )
      : null;
  const fees =
    feeSnapshotsResult.status === "fulfilled" &&
    feeSnapshotsResult.value.error === null &&
    ssrRatesError === null
      ? aggregateProtocolFees(feeSnapshots, rates)
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

  // Legacy v2 daily volume — already filtered to `routedViaV3Router=false`
  // server-side, so no client-side disambiguation is needed.
  const brokerSnapshotsAllDaily =
    brokerSnapshotsAllDailyResult.status === "fulfilled"
      ? brokerSnapshotsAllDailyResult.value.rows
      : [];
  const brokerSnapshotsAllDailyTruncated =
    brokerSnapshotsAllDailyResult.status === "fulfilled"
      ? brokerSnapshotsAllDailyResult.value.truncated
      : false;
  const brokerSnapshotsAllDailyError =
    brokerSnapshotsAllDailyResult.status === "rejected"
      ? toError(brokerSnapshotsAllDailyResult.reason)
      : (brokerSnapshotsAllDailyResult.value.error ?? null);

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

  // `detectProbedStrategies` already fails open (catches and Sentry-logs
  // RPC errors itself), so a rejected Promise here would signal something
  // the helper couldn't swallow — still degrade to empty so the fetch
  // overall stays up. Consumers downstream treat "pool absent from both
  // sets" as "detection unavailable" and avoid confident badges.
  const { cdpPoolIds, reservePoolIds } =
    cdpPoolIdsResult.status === "fulfilled"
      ? cdpPoolIdsResult.value
      : { cdpPoolIds: new Set<string>(), reservePoolIds: new Set<string>() };

  return {
    network,
    snapshotWindows: windows,
    pools,
    snapshots,
    snapshots7d,
    snapshots30d,
    snapshotsAllDaily,
    snapshotsAllDailyTruncated,
    brokerSnapshotsAllDaily,
    brokerSnapshotsAllDailyTruncated,
    tradingLimits,
    olsPoolIds,
    cdpPoolIds,
    reservePoolIds,
    fees,
    feeSnapshots,
    feeSnapshotsError,
    feeSnapshotsTruncated,
    ratesError: ssrRatesError,
    poolLabels: new Map(),
    uniqueLpAddresses,
    rates,
    error: null,
    // Per-window errors — only set when the specific window is incomplete.
    // See the `windowError` helper above.
    snapshotsError,
    snapshots7dError,
    snapshots30dError,
    snapshotsAllDailyError,
    brokerSnapshotsAllDailyError,
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
