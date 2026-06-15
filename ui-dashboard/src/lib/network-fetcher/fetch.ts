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
  ALL_POOLS_HEALTH_CURSOR,
  ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN,
  ALL_POOLS_WITH_HEALTH,
  ALL_OLS_POOLS,
  ALL_CDP_POOLS,
  BROKER_DAILY_SNAPSHOTS_ALL,
  POOL_DAILY_FEE_SNAPSHOTS_PAGE,
  POOL_DAILY_SNAPSHOTS_ALL,
  UNIQUE_LP_ADDRESSES,
} from "@/lib/queries";
import { aggregateProtocolFees } from "@/lib/protocol-fees";
import { usesRuntimeStrategyProbe } from "@/lib/strategy-probe-scope";
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
  OlsPool,
  CdpPool,
} from "@/lib/types";
import { isFpmm, buildOracleRateMap } from "@/lib/tokens";
import type {
  BrokerDailySnapshotRow,
  NetworkData,
  PaginatedPageResult,
  SerializableError,
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
 * `brokerSnapshotsAllDailyTruncated`, `uniqueLpAddressesTruncated`) are
 * intentionally excluded — they represent a permanent cap-exhaustion state
 * until `SNAPSHOT_MAX_PAGES` is raised. Including them would force perpetual
 * mount-time revalidation that can never recover. The UI surfaces truncation
 * via the `≈` prefix + subtitle; this gate is for transient errors only.
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
    n.strategyError === null &&
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
  olsPoolIds: new Set(),
  cdpPoolIds: new Set(),
  reservePoolIds: new Set(),
  strategyError: null,
  fees: null,
  feeSnapshots: [],
  feeSnapshotsError: null,
  feeSnapshotsTruncated: false,
  ratesError: null,
  poolLabels: new Map(),
  uniqueLpAddresses: null,
  uniqueLpAddressesTruncated: false,
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
export async function fetchPaginatedRows<TRow, TVars>(args: {
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
 * Paginate `LiquidityPosition` rows for a set of pool IDs, deduplicating
 * by lowercase address. One LP may hold positions in multiple pools, so
 * the same wallet address can appear across rows — dedup collapses them
 * to a unique-address list. Same fail-open semantics as the daily snapshot
 * path: hard-fail on page 0, preserve and flag truncated on mid-loop failure.
 */
async function fetchAllLpAddressPages(
  client: GraphQLClient,
  poolIds: string[],
  network: string,
): Promise<PaginatedPageResult<{ address: string }>> {
  return fetchPaginatedRows<{ address: string }, unknown>({
    client,
    query: UNIQUE_LP_ADDRESSES,
    responseKey: "LiquidityPosition",
    network,
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
 * Per-pool fee-snapshot pagination — pool×day cardinality (~30 pools × ~430
 * days) easily exceeds the 1000-row cap, so we paginate. Same fail-open
 * semantics as the daily snapshot path. Dedup keyed off `id` since
 * `PoolDailyFeeSnapshot.id = "{chainId}-{poolAddress}-{dayTs}"` is unique by
 * construction. Exported because the slim `useProtocolFees` hook fetches its
 * own snapshots — the homepage path in `fetchNetworkData` doesn't render the
 * per-pool revenue table so it leaves `feeSnapshots` empty.
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
// eslint-disable-next-line complexity, max-lines-per-function, sonarjs/cognitive-complexity -- Existing network orchestrator owns many fail-open slices; keep the exception visible in source instead of carrying a churn-prone baseline tuple.
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
      ...(variables !== undefined ? { variables } : {}),
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
    olsResult,
    breachRollupResult,
    healthCursorResult,
    rebalanceThresholdsKnownResult,
    indexedCdpPoolsResult,
    fallbackStrategiesResult,
  ] = await Promise.allSettled([
    fetchAllFeeSnapshotPages(client, network.chainId, network.id),
    shouldQueryPoolSnapshots(poolIds)
      ? fetchAllDailySnapshotPages(client, poolIds, network.id)
      : Promise.resolve(emptySnapshotPage),
    // Legacy v2 daily volume rollup (Broker.Swap with `routedViaV3Router=false`).
    // Filtered server-side by chainId — only Celo has a Broker today, but
    // querying on every chain is harmless (Monad simply returns 0 rows).
    fetchAllBrokerDailySnapshotPages(client, network.chainId, network.id),
    fpmmPoolIds.length > 0
      ? fetchAllLpAddressPages(client, fpmmPoolIds, network.id)
      : Promise.resolve({
          rows: [] as { address: string }[],
          truncated: false,
          error: null,
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
    // Live-tail cursor is isolated so schema-lag does not hide persisted uptime counters.
    timed<{
      Pool: {
        id: string;
        lastOracleSnapshotTimestamp?: string;
        lastDeviationRatio?: string;
      }[];
    }>(ALL_POOLS_HEALTH_CURSOR, { chainId: network.chainId }),
    // Data-trust / degenerate-classification flags. Isolated so schema-lag
    // degrades thresholds, USD math, and degenerate health without failing
    // the main pool list; split sides are needed for `isNeverRebalance`.
    timed<{
      Pool: {
        id: string;
        rebalanceThresholdAbove?: number;
        rebalanceThresholdBelow?: number;
        rebalanceThresholdsKnown?: boolean;
        tokenDecimalsKnown?: boolean;
        degenerateReserves?: boolean;
        breakerTripped?: boolean;
      }[];
    }>(ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN, { chainId: network.chainId }),
    // CDP badges are Celo-only and come from indexed CdpPool rows. The
    // runtime probe is a non-Celo Reserve fallback and must not produce CDP
    // badges.
    requestIndexedCdpPools(network, timed),
    requestFallbackStrategies(network, pools),
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

  // Merge live-tail cursor fields; on schema-lag, persisted health counters remain usable.
  if (healthCursorResult.status === "fulfilled") {
    const cursorById = new Map(
      (healthCursorResult.value.Pool ?? []).map((r) => [r.id, r]),
    );
    pools = pools.map((p) => {
      const r = cursorById.get(p.id);
      return r == null
        ? p
        : {
            ...p,
            lastOracleSnapshotTimestamp: r.lastOracleSnapshotTimestamp,
            lastDeviationRatio: r.lastDeviationRatio,
          };
    });
  }

  // Merge isolated flags. On schema-lag, fields stay undefined and consumers
  // use conservative fallbacks instead of failing the whole pool list.
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
            degenerateReserves: r.degenerateReserves,
            breakerTripped: r.breakerTripped,
          };
    });
  }

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
      ? Number(snapshotsAllDaily[snapshotsAllDaily.length - 1]!.timestamp)
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

  // fetchAllLpAddressPages deduplicates by address.toLowerCase() internally,
  // so the rows are already unique — no second Set pass needed.
  const uniqueLpAddresses =
    lpResult.status === "fulfilled"
      ? lpResult.value.rows.map((r) => r.address)
      : null;
  const uniqueLpAddressesTruncated =
    lpResult.status === "fulfilled" && lpResult.value.truncated;

  const olsPoolIds =
    olsResult.status === "fulfilled"
      ? new Set((olsResult.value.OlsPool ?? []).map((p) => p.poolId))
      : new Set<string>();

  const { cdpPoolIds, reservePoolIds } = resolveStrategyIds({
    network,
    pools,
    indexedCdpPoolsResult,
    fallbackStrategiesResult,
  });
  const strategyError = resolveStrategyError({
    network,
    olsResult,
    indexedCdpPoolsResult,
    fallbackStrategiesResult,
  });

  return {
    network,
    snapshotWindows: windows,
    pools,
    snapshots: filterSnapshotsToWindow(snapshotsAllDaily, dw24h),
    snapshots7d,
    snapshots30d,
    snapshotsAllDaily,
    snapshotsAllDailyTruncated,
    brokerSnapshotsAllDaily,
    brokerSnapshotsAllDailyTruncated,
    olsPoolIds,
    cdpPoolIds,
    reservePoolIds,
    strategyError,
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
    uniqueLpAddressesTruncated,
    lpError:
      lpResult.status === "rejected"
        ? toError(lpResult.reason)
        : (lpResult.value.error ?? null),
  };
}

const INDEXED_CDP_POOL_CHAIN_IDS = new Set([42220]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type TimedRequest = <T>(
  document: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

type CdpPoolsResponse = {
  CdpPool: Pick<CdpPool, "poolId" | "strategyAddress">[];
};

type ProbedStrategies = {
  cdpPoolIds: Set<string>;
  reservePoolIds: Set<string>;
};

type StrategyIdsArgs = {
  network: Network;
  pools: Pool[];
  indexedCdpPoolsResult: PromiseSettledResult<CdpPoolsResponse>;
  fallbackStrategiesResult: PromiseSettledResult<Readonly<ProbedStrategies>>;
};

type StrategyErrorArgs = {
  network: Network;
  olsResult: PromiseSettledResult<{ OlsPool: Pick<OlsPool, "poolId">[] }>;
  indexedCdpPoolsResult: PromiseSettledResult<CdpPoolsResponse>;
  fallbackStrategiesResult: PromiseSettledResult<Readonly<ProbedStrategies>>;
};

function usesIndexedCdpPools(network: Pick<Network, "chainId">): boolean {
  return INDEXED_CDP_POOL_CHAIN_IDS.has(network.chainId);
}

function hasRebalancerAddress(pool: Pool): boolean {
  const rebalancer = pool.rebalancerAddress;
  return (
    rebalancer !== undefined &&
    /^0x[a-fA-F0-9]{40}$/.test(rebalancer) &&
    rebalancer.toLowerCase() !== ZERO_ADDRESS
  );
}

function activeCdpPoolIdsFromIndexedRows(
  pools: Pool[],
  cdpPools: Pick<CdpPool, "poolId" | "strategyAddress">[],
): Set<string> {
  const activeRebalancerByPoolId = new Map<string, string>();
  for (const pool of pools) {
    if (!hasRebalancerAddress(pool)) continue;
    const rebalancer = pool.rebalancerAddress;
    if (rebalancer === undefined) continue;
    activeRebalancerByPoolId.set(pool.id, rebalancer.toLowerCase());
  }

  const cdpPoolIds = new Set<string>();
  for (const cdpPool of cdpPools) {
    const activeRebalancer = activeRebalancerByPoolId.get(cdpPool.poolId);
    if (activeRebalancer === undefined) continue;
    if (cdpPool.strategyAddress?.toLowerCase() !== activeRebalancer) continue;
    cdpPoolIds.add(cdpPool.poolId);
  }
  return cdpPoolIds;
}

function emptyStrategyIds(): ProbedStrategies {
  return {
    cdpPoolIds: new Set<string>(),
    reservePoolIds: new Set<string>(),
  };
}

function requestIndexedCdpPools(
  network: Network,
  timed: TimedRequest,
): Promise<CdpPoolsResponse> {
  if (!usesIndexedCdpPools(network)) return Promise.resolve({ CdpPool: [] });
  return timed<CdpPoolsResponse>(ALL_CDP_POOLS, { chainId: network.chainId });
}

async function requestFallbackStrategies(
  network: Network,
  pools: Pool[],
): Promise<Readonly<ProbedStrategies>> {
  if (!usesRuntimeStrategyProbe(network)) return emptyStrategyIds();
  const { detectProbedStrategies } = await import("@/lib/strategy-detection");
  return detectProbedStrategies(network, pools);
}

function resolveStrategyIds({
  network,
  pools,
  indexedCdpPoolsResult,
  fallbackStrategiesResult,
}: StrategyIdsArgs): ProbedStrategies {
  const fallbackStrategies =
    fallbackStrategiesResult.status === "fulfilled"
      ? fallbackStrategiesResult.value
      : emptyStrategyIds();

  if (!usesIndexedCdpPools(network)) {
    return {
      cdpPoolIds: new Set<string>(),
      reservePoolIds: fallbackStrategies.reservePoolIds,
    };
  }

  const cdpPoolIds =
    indexedCdpPoolsResult.status === "fulfilled"
      ? activeCdpPoolIdsFromIndexedRows(
          pools,
          indexedCdpPoolsResult.value.CdpPool ?? [],
        )
      : new Set<string>();

  return {
    cdpPoolIds,
    // Indexed Celo has a positive CDP source, but no positive Reserve source.
    // Unknown active rebalancers stay unbadged instead of being inferred as
    // Reserve from the absence of an OLS/CDP row.
    reservePoolIds: new Set<string>(),
  };
}

function resolveStrategyError({
  network,
  olsResult,
  indexedCdpPoolsResult,
  fallbackStrategiesResult,
}: StrategyErrorArgs): Error | null {
  if (olsResult.status === "rejected") return toError(olsResult.reason);
  if (
    usesIndexedCdpPools(network) &&
    indexedCdpPoolsResult.status === "rejected"
  )
    return toError(indexedCdpPoolsResult.reason);
  if (
    usesRuntimeStrategyProbe(network) &&
    fallbackStrategiesResult.status === "rejected"
  )
    return toError(fallbackStrategiesResult.reason);
  return null;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Rebuild a `NetworkData`'s ten error channels as plain `{ message }` objects
 * (#661). `fetchNetworkData` populates them with `Error` instances internally
 * (structurally assignable to `SerializableError`), but those must not cross
 * the Server → Client boundary: React's Flight serializer opaques `Error`
 * instances to a generic "…message is omitted in production builds…"
 * placeholder, which would then render into `<ErrorBox>` instead of the real
 * cause. Reading `.message` into a fresh literal yields a plain object that
 * survives serialization. Idempotent — a value already shaped `{ message }`
 * round-trips unchanged. Applied once, here at the `fetchAllNetworks` boundary
 * (per the issue), so `fetchNetworkData` stays a pure internal fetcher.
 */
function toSerializableError(
  e: SerializableError | null,
): SerializableError | null {
  return e === null ? null : { message: e.message };
}

function withSerializableErrors(data: NetworkData): NetworkData {
  return {
    ...data,
    error: toSerializableError(data.error),
    ratesError: toSerializableError(data.ratesError),
    feeSnapshotsError: toSerializableError(data.feeSnapshotsError),
    snapshotsError: toSerializableError(data.snapshotsError),
    snapshots7dError: toSerializableError(data.snapshots7dError),
    snapshots30dError: toSerializableError(data.snapshots30dError),
    snapshotsAllDailyError: toSerializableError(data.snapshotsAllDailyError),
    brokerSnapshotsAllDailyError: toSerializableError(
      data.brokerSnapshotsAllDailyError,
    ),
    strategyError: toSerializableError(data.strategyError),
    lpError: toSerializableError(data.lpError),
  };
}

/**
 * Fetches pools, full-history daily snapshots (paginated), protocol fees, and
 * LP counts for ALL configured networks in parallel. Window-specific snapshot
 * arrays (24h/7d/30d) are derived in-memory from `snapshotsAllDaily` so we
 * make one paginated request instead of four overlapping ones, and avoid
 * Hasura's silent 1000-row cap on windowed queries. Uses Promise.allSettled
 * so one failing network doesn't block others. Error channels are flattened to
 * plain `{ message }` objects so they survive the RSC boundary (see #661).
 */
export async function fetchAllNetworks(): Promise<NetworkData[]> {
  const configuredNetworkIds = NETWORK_IDS.filter(isConfiguredNetworkId);
  const now = Date.now();
  const windows = buildSnapshotWindows(now);

  const results = await Promise.allSettled(
    configuredNetworkIds.map((id) => fetchNetworkData(NETWORKS[id], windows)),
  );

  return results.map((result, i) => {
    const networkData =
      result.status === "fulfilled"
        ? result.value
        : emptyNetworkData(
            NETWORKS[configuredNetworkIds[i]!],
            windows,
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          );
    return withSerializableErrors(networkData);
  });
}
