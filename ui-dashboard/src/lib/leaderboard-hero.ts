/**
 * Hero KPI rollup for the /leaderboard page.
 *
 * The hero tiles (total volume / total swaps / unique traders) read the
 * pre-rolled LeaderboardWindowSnapshot for the [windowStart, yesterday]
 * range and add today's partial from a small TraderDailySnapshot direct
 * query. `mergeHeroSnapshot` does the addition.
 *
 * Concentration % is NOT computed there — the caller divides the top-50
 * query's top-10 sum (via `top10Concentration`) by
 * `mergeHeroSnapshot().totalVolumeUsdWei` to get an exact ratio. We
 * deliberately avoid pre-rolling top-N volumes indexer-side: top-50 is
 * exact via the existing query (see queries/leaderboard.ts lemma), and
 * the snapshot only needs to supply the exact denominator.
 *
 * Extracted from `lib/leaderboard.ts` to keep that file under the
 * 600-line soft cap (see repo-root AGENTS.md "File-size budget").
 */

import { SECONDS_PER_DAY } from "@/lib/time-series";

/** Wire shape of LeaderboardWindowSnapshot / BrokerLeaderboardWindowSnapshot
 *  rows from the primary query. Both v3 and v2 GraphQL queries return the
 *  same fields. The primary total* fields exclude system addresses; the
 *  *IncludingSystem siblings feed the "Show system addresses = on" toggle.
 *
 *  The `firstDay*` slice ships in a SEPARATE isolated query
 *  (`LEADERBOARD_WINDOW_FIRSTDAY_LATEST`) — see
 *  `LeaderboardWindowFirstDayRow` — so that a hosted-Hasura schema lag
 *  on the new columns can degrade JUST the DEGRADED-chain catch-up
 *  rather than blanking the hero KPIs entirely. */
export type LeaderboardWindowRow = {
  id: string;
  chainId: number;
  windowKey: string;
  snapshotDay: string;
  windowStartDay: string;
  totalVolumeUsdWei: string;
  totalVolumeUsdWeiIncludingSystem: string;
  totalSwapCount: number;
  totalSwapCountIncludingSystem: number;
  uniqueTraders: number;
  uniqueTradersIncludingSystem: number;
};

/** Wire shape of the isolated first-day slice query
 *  (`LEADERBOARD_WINDOW_FIRSTDAY_LATEST` / broker sibling). Joined
 *  client-side onto `LeaderboardWindowRow` by `chainId` so the page
 *  survives a hosted-Hasura schema lag on the new columns — only the
 *  DEGRADED-chain catch-up degrades, the hero KPIs stay rendered.
 *
 *  Always 0 for `all` and `24h` windows by design (no first-day
 *  boundary / empty range respectively); populated for `7d` / `30d` /
 *  `90d`. */
export type LeaderboardWindowFirstDayRow = {
  chainId: number;
  snapshotDay: string;
  firstDayVolumeUsdWei: string;
  firstDayVolumeUsdWeiIncludingSystem: string;
  firstDaySwapCount: number;
  firstDaySwapCountIncludingSystem: number;
  firstDayExclusiveUniqueTraders: number;
  firstDayExclusiveUniqueTradersIncludingSystem: number;
};

/** Bounded historical-overlap row for partial-day traders. The query is
 *  distinct on `(chainId, trader, isSystemAddress)`, so it returns at most
 *  two rows per active yesterday/today trader and avoids polling full
 *  cumulative snapshot trader arrays. */
export type LeaderboardPartialOverlapRow = {
  chainId: number;
  trader: string;
  timestamp: string;
  isSystemAddress: boolean;
};

/** Wire shape of today's partial trader-day rows. v3 and v2 share this
 *  minimal subset (we only need volume + swap count + system flag). */
export type LeaderboardTodayTraderRow = {
  chainId: number;
  trader: string;
  volumeUsdWei: string;
  swapCount: number;
  isSystemAddress: boolean;
};

export type HeroSnapshotTotals = {
  totalVolumeUsdWei: bigint;
  totalSwapCount: number;
  uniqueTraders: number;
  /** Chain IDs whose latest rolling-window snapshot's `snapshotDay` is
   * older than `today - 2 UTC days` — meaning the chain has been silent
   * for at least one full UTC day beyond the indexer's normal
   * pre-heartbeat lag, and recent days are missing from the snapshot
   * window. The snapshot AND the chain's today's partial are EXCLUDED
   * from the totals above; the page surfaces a banner naming the
   * affected chains.
   *
   * Only populated for rolling windows (`7d`/`30d`/`90d`). The `all`
   * window is cumulative — old snapshots stay correct because empty
   * intervening days contribute zero volume. The `24h` window is
   * intentionally written as an empty range by the indexer and is
   * fully covered by today's partial, so a stale `24h` snapshotDay
   * carries no missing-data signal. */
  staleChains: number[];
  /** Chain IDs whose latest rolling-window snapshot is exactly one UTC
   * day old (`snapshotDay = today - 2 days`) — the canonical
   * pre-first-swap-of-day state. Yesterday's data isn't yet in the
   * snapshot AND there's nothing in `todayRows` for it (no swap today
   * yet), so hero KPIs silently miss yesterday's volume until the next
   * swap fires the heartbeat.
   *
   * The snapshot is KEPT in the totals (its historical volume is still
   * correct) — only the most recent closed day is missing. The page
   * surfaces a lighter "degraded" banner so users know the number is
   * recent-incomplete, not historically wrong.
   *
   * Same window-key gating as `staleChains`. */
  degradedChains: number[];
};

/** Rolling-window keys whose `snapshotDay` is meaningful for staleness
 *  detection. The other window keys (`all`, `24h`) are deliberately
 *  excluded — see `HeroSnapshotTotals.staleChains` for the rationale.
 *  Mirrors `WINDOW_KEYS` in `indexer-envio/src/leaderboardWindowSnapshot.ts`
 *  (the indexer and dashboard packages don't share types). */
function isStaleableWindow(windowKey: string): boolean {
  return windowKey === "7d" || windowKey === "30d" || windowKey === "90d";
}

/** Build a `{chainId-snapshotDay}` lookup over the isolated firstDay
 *  rows. Keying by both fields (not just chainId) defends against the
 *  brief heartbeat-cadence window where the primary snapshot query
 *  and the isolated firstDay query could land on different
 *  snapshotDays for the same chainId — a stale-cache mismatch would
 *  otherwise subtract a slice that doesn't belong to the snapshot. */
function buildFirstDaySnapshotKeyMap(
  rows: ReadonlyArray<LeaderboardWindowFirstDayRow>,
): Map<string, LeaderboardWindowFirstDayRow> {
  const m = new Map<string, LeaderboardWindowFirstDayRow>();
  for (const row of rows) {
    m.set(`${row.chainId}-${row.snapshotDay}`, row);
  }
  return m;
}

export type LeaderboardPartialOverlapQueryInput = {
  where: Record<string, unknown>;
  limit: number;
};

// Hasura caps query responses at 1000 rows. The overlap query can return
// one non-system and one system row per active partial trader, so exact mode
// stops at 500 active keys and falls back above that.
const MAX_PARTIAL_OVERLAP_QUERY_ROWS = 1000;
const MAX_PARTIAL_OVERLAP_KEYS = MAX_PARTIAL_OVERLAP_QUERY_ROWS / 2;

function traderKey(chainId: number, trader: string): string {
  return `${chainId}-${trader}`;
}

function buildHistoricalOverlapKeys(
  rows: ReadonlyArray<LeaderboardPartialOverlapRow>,
  showSystem: boolean,
): Set<string> {
  if (showSystem) {
    return new Set(rows.map((row) => traderKey(row.chainId, row.trader)));
  }

  const statusByKey = new Map<
    string,
    { seenNonSystem: boolean; seenSystem: boolean }
  >();
  for (const row of rows) {
    const key = traderKey(row.chainId, row.trader);
    const status = statusByKey.get(key) ?? {
      seenNonSystem: false,
      seenSystem: false,
    };
    if (row.isSystemAddress) {
      status.seenSystem = true;
    } else {
      status.seenNonSystem = true;
    }
    statusByKey.set(key, status);
  }

  const overlapKeys = new Set<string>();
  for (const [key, status] of statusByKey) {
    // Snapshot uniqueTraders is sticky-system: any system day excludes that
    // trader from the hidden-system count, even if another day was non-system.
    if (status.seenNonSystem && !status.seenSystem) {
      overlapKeys.add(key);
    }
  }
  return overlapKeys;
}

function addPartialRowsByChain(
  rows: ReadonlyArray<LeaderboardTodayTraderRow> | undefined,
  staleChainSet: ReadonlySet<number>,
  showSystem: boolean,
  out: Map<number, Set<string>>,
): void {
  for (const row of rows ?? []) {
    if (staleChainSet.has(row.chainId)) continue;
    if (!showSystem && row.isSystemAddress) continue;
    const traders = out.get(row.chainId);
    if (traders) {
      traders.add(row.trader);
    } else {
      out.set(row.chainId, new Set([row.trader]));
    }
  }
}

export function buildHeroPartialOverlapQueryInput(args: {
  snapshotRows: ReadonlyArray<LeaderboardWindowRow> | undefined;
  todayRows: ReadonlyArray<LeaderboardTodayTraderRow> | undefined;
  firstDayRows?: ReadonlyArray<LeaderboardWindowFirstDayRow> | undefined;
  yesterdayRows?: ReadonlyArray<LeaderboardTodayTraderRow> | undefined;
  showSystem: boolean;
  todayMidnightSeconds: number;
  traderField?: "trader" | "caller";
}): LeaderboardPartialOverlapQueryInput | null | undefined {
  if (!args.snapshotRows || args.snapshotRows.length === 0) return null;

  const staleCutoffSeconds = args.todayMidnightSeconds - 2 * SECONDS_PER_DAY;
  const degradedCutoffSeconds = args.todayMidnightSeconds - SECONDS_PER_DAY;
  const firstDayBySnapshotKey = args.firstDayRows
    ? buildFirstDaySnapshotKeyMap(args.firstDayRows)
    : null;
  const staleChains = new Set<number>();
  const snapshotRangesByChain = new Map<
    number,
    { start: number; end: number }
  >();

  for (const row of args.snapshotRows) {
    const snapDay = Number(row.snapshotDay);
    let start = Number(row.windowStartDay);
    if (isStaleableWindow(row.windowKey)) {
      if (snapDay < staleCutoffSeconds) {
        staleChains.add(row.chainId);
        continue;
      }
      if (snapDay < degradedCutoffSeconds) {
        const firstDay = firstDayBySnapshotKey?.get(
          `${row.chainId}-${row.snapshotDay}`,
        );
        if (args.yesterdayRows !== undefined && firstDay) {
          start += SECONDS_PER_DAY;
        }
      }
    }
    if (start <= snapDay) {
      snapshotRangesByChain.set(row.chainId, { start, end: snapDay });
    }
  }

  const partialRowsByChain = new Map<number, Set<string>>();
  const traderField = args.traderField ?? "trader";
  addPartialRowsByChain(
    args.todayRows,
    staleChains,
    args.showSystem,
    partialRowsByChain,
  );
  addPartialRowsByChain(
    args.yesterdayRows,
    staleChains,
    args.showSystem,
    partialRowsByChain,
  );

  const clauses: Record<string, unknown>[] = [];
  let limit = 0;
  for (const [chainId, traders] of partialRowsByChain) {
    const range = snapshotRangesByChain.get(chainId);
    if (!range || traders.size === 0) continue;
    const traderList = Array.from(traders).sort();
    limit += traderList.length;
    clauses.push({
      chainId: { _eq: chainId },
      [traderField]: { _in: traderList },
      timestamp: { _gte: range.start, _lte: range.end },
    });
  }

  if (clauses.length === 0) return null;
  if (limit > MAX_PARTIAL_OVERLAP_KEYS) return undefined;
  return { where: { _or: clauses }, limit: limit * 2 };
}

/**
 * Sum hero-tile totals across all chains, combining the pre-rolled
 * [windowStart, yesterday] snapshot with today's partial.
 *
 * `showSystem` selects between the snapshot's primary fields (system
 * excluded — matches the dashboard's default view and the table's
 * filter) and the *IncludingSystem variants. Today's rows are
 * pre-filtered by the `isSystemAddressIn` query variable, so the
 * showSystem branch only filters out anything that snuck through.
 *
 * The unique-trader count uses a bounded historical-overlap query for
 * yesterday/today partial traders when it has landed. During schema rollout,
 * query failure, or a large active-partial set it falls back to the legacy
 * count-based path, which adds snapshot + yesterday + today counts without
 * cross-source de-duping.
 *
 * `todayMidnightSeconds` is the UTC midnight of "today" in Unix seconds
 * (must match the unit `snapshotDay` is stored in — see
 * `indexer-envio/schema.graphql` LeaderboardWindowSnapshot.snapshotDay
 * and `indexer-envio/src/helpers.ts:dayBucket`).
 *
 * Two-threshold staleness rule (rolling windows only — `7d`/`30d`/`90d`):
 *
 *   snapshotDay < today - 2 days  →  STALE: chain dropped from totals
 *                                    AND its today's partial dropped
 *                                    (so the top-10 concentration mask
 *                                    stays consistent with the
 *                                    denominator).
 *
 *   snapshotDay = today - 2 days  →  DEGRADED: snapshot kept in totals
 *                                    (historical volume still correct),
 *                                    but yesterday's closed-day data
 *                                    isn't yet in either source. Caller
 *                                    surfaces a lighter banner.
 *
 *   snapshotDay ≥ today - 1 day   →  FRESH: heartbeat-cadence baseline.
 *
 * Two thresholds (not one) because the indexer's heartbeat fires on the
 * first swap of a new UTC day, writing the previous day's snapshot. So
 * `today - 2 days` is the canonical pre-first-swap-today state for an
 * active chain, and dropping its whole snapshot would erase real
 * historical volume — but not warning is also wrong, since yesterday's
 * trader rows are in neither the snapshot nor `todayRows` until the
 * heartbeat fires.
 *
 * `all` and `24h` rows are never marked stale or degraded: `all` is
 * cumulative from epoch (empty days don't invalidate the total), and
 * `24h` is written as an intentionally-empty range by the indexer and
 * fully covered by `todayRows` on the dashboard side.
 *
 * Optional DEGRADED-chain catch-up (slice subtraction): when the
 * caller passes `yesterdayRows` (a `TraderDailySnapshot` query
 * filtered to `timestamp = todayMidnight - 86400` and gated on
 * `chainId_in: degradedChains`), this helper supplements the rollup
 * for every degraded chain by:
 *
 *   1. subtracting the snapshot's `firstDay*` slice (the boundary
 *      day that would otherwise be double-counted because
 *      `windowStartDay` slides with `snapshotDay`),
 *   2. adding yesterday's rows on top,
 *   3. dropping the chain from the returned `degradedChains` list.
 *
 * For a `7d` window with `snapshotDay = T-2`, the snapshot covers
 * `[T-7, T-2]` (6 days). Naively adding yesterday + today on top
 * yields `[T-7, T]` = 8 days. Slice subtraction drops `T-7` so the
 * effective window becomes `[T-6, T]` = 7 days, matching the
 * non-degraded baseline.
 *
 * The semantics distinguish "query not yet fired / completed" from
 * "query completed, chain genuinely silent yesterday":
 *
 *   yesterdayRows === undefined  →  caller hasn't fired the query
 *                                   yet (or it errored). Every
 *                                   degraded chain stays in
 *                                   `degradedChains`; banner is
 *                                   shown until data lands.
 *
 *   yesterdayRows === []         →  query completed authoritatively
 *                                   (zero activity yesterday across
 *                                   all degraded chains). Every
 *                                   degraded chain still gets its
 *                                   firstDay slice subtracted —
 *                                   sliding the window forward by one
 *                                   day with a zero contribution from
 *                                   yesterday is correct, not "data
 *                                   missing".
 *
 *   yesterdayRows = [..rows..]   →  partial: chains with rows get
 *                                   their slice + yesterday rows;
 *                                   chains without rows still get
 *                                   the slice subtraction (zero
 *                                   yesterday contribution).
 *
 * Unique-trader precision: with `partialOverlapRows`, the count starts from
 * the retained snapshot unique count, then adds only yesterday/today traders
 * that did not appear in that retained snapshot range. Without overlap rows,
 * the fallback count path remains approximate; volume and swap counts are
 * exact through slice subtraction either way.
 */
export function mergeHeroSnapshot(args: {
  snapshotRows: ReadonlyArray<LeaderboardWindowRow> | undefined;
  todayRows: ReadonlyArray<LeaderboardTodayTraderRow> | undefined;
  /** First-day slice for the same (chainId, snapshotDay) tuples as
   *  `snapshotRows`, joined client-side. Lives in a separate isolated
   *  query so a hosted-Hasura schema lag on the new columns degrades
   *  ONLY the catch-up (chains stay degraded) instead of failing the
   *  primary hero query. `undefined` until the isolated query lands. */
  firstDayRows?: ReadonlyArray<LeaderboardWindowFirstDayRow> | undefined;
  /** Distinct historical rows for yesterday/today partial traders that
   *  already occurred in the retained snapshot range. Lives in an isolated
   *  query so schema lag degrades only unique-trader precision. */
  partialOverlapRows?: ReadonlyArray<LeaderboardPartialOverlapRow> | undefined;
  /** Optional yesterday's-closed-day rows (one trader-day per row),
   *  used to catch up DEGRADED chains via slice subtraction. Caller
   *  fires `LEADERBOARD_YESTERDAY_TRADERS` only when `degradedChains`
   *  from a prior pass is non-empty; `undefined` otherwise. */
  yesterdayRows?: ReadonlyArray<LeaderboardTodayTraderRow> | undefined;
  showSystem: boolean;
  todayMidnightSeconds: number;
}): HeroSnapshotTotals {
  // Stale: snapshot strictly older than two-days-ago midnight (≥3 UTC
  // days old). Degraded: snapshot is exactly two-days-ago (one full
  // UTC day older than the heartbeat baseline). Comparison is `<`, so
  // a snapshotDay equal to the cutoff lands in the lighter bucket.
  const staleCutoffSeconds = args.todayMidnightSeconds - 2 * SECONDS_PER_DAY;
  const degradedCutoffSeconds = args.todayMidnightSeconds - SECONDS_PER_DAY;
  let totalVolumeUsdWei = BigInt(0);
  let totalSwapCount = 0;
  let uniqueFromSnapshot = 0;
  const staleChains: number[] = [];
  const degradedChains: number[] = [];
  const partialTraderKeys = new Set<string>();
  // Track per-chain snapshot rows for degraded chains so the post-pass
  // slice-subtraction step can read the firstDay* fields without
  // re-iterating the whole list.
  const degradedSnapshotByChain = new Map<number, LeaderboardWindowRow>();
  for (const row of args.snapshotRows ?? []) {
    if (isStaleableWindow(row.windowKey)) {
      const snapDay = Number(row.snapshotDay);
      if (snapDay < staleCutoffSeconds) {
        // Skip stale rows entirely — applies to both showSystem branches
        // because staleness is independent of system-address filtering.
        staleChains.push(row.chainId);
        continue;
      }
      if (snapDay < degradedCutoffSeconds) {
        // Pre-first-swap-today state. Snapshot still contributes to
        // totals (it covers everything up to two-days-ago, which is
        // most of the window); yesterday's closed-day data is the only
        // gap and is signaled to the user via a lighter banner.
        degradedChains.push(row.chainId);
        degradedSnapshotByChain.set(row.chainId, row);
      }
    }
    if (args.showSystem) {
      totalVolumeUsdWei += BigInt(row.totalVolumeUsdWeiIncludingSystem);
      totalSwapCount += row.totalSwapCountIncludingSystem;
      uniqueFromSnapshot += row.uniqueTradersIncludingSystem;
    } else {
      totalVolumeUsdWei += BigInt(row.totalVolumeUsdWei);
      totalSwapCount += row.totalSwapCount;
      uniqueFromSnapshot += row.uniqueTraders;
    }
  }
  // Today's rows: stale chains are excluded so the denominator and the
  // top-10 numerator describe the same effective population. Degraded
  // chains stay in (they're a "snapshot is one closed day behind" state,
  // not a "drop this chain" state).
  const staleChainSet = new Set(staleChains);
  const todayTraders = new Set<string>();
  for (const row of args.todayRows ?? []) {
    if (staleChainSet.has(row.chainId)) continue;
    if (!args.showSystem && row.isSystemAddress) continue;
    totalVolumeUsdWei += BigInt(row.volumeUsdWei);
    totalSwapCount += row.swapCount;
    const key = traderKey(row.chainId, row.trader);
    todayTraders.add(key);
    partialTraderKeys.add(key);
  }

  // ─── Degraded-chain catch-up via slice subtraction ──────────────
  // For each degraded chain: drop the snapshot's first-day slice, then
  // add any yesterday rows for the chain. Net effect on a 7d window
  // with snapshotDay=T-2: snapshot covered [T-7, T-2] (6 days); after
  // subtraction it covers [T-6, T-2] (5 days); add yesterday (T-1)
  // and today (already added above) to land at [T-6, T] = 7 days. Same
  // identity for 30d/90d.
  //
  // The catch-up requires BOTH the isolated firstDay query
  // (`firstDayRows`) AND the yesterday-traders query (`yesterdayRows`)
  // to have landed. `undefined` for either means the catch-up isn't
  // ready — chain stays degraded, banner shown. Empty arrays are
  // authoritative ("query completed, zero contribution") and trigger
  // the slice subtraction with a zero yesterday contribution.
  const remainingDegradedChains: number[] = [];
  let yesterdayUniqueTradersAdded = 0;
  const firstDayBySnapshotKey = args.firstDayRows
    ? buildFirstDaySnapshotKeyMap(args.firstDayRows)
    : null;
  if (args.yesterdayRows !== undefined && firstDayBySnapshotKey !== null) {
    // Bucket yesterday's rows by chainId (and apply the system filter)
    // once, so the per-chain loop is O(degradedChains.length).
    const yesterdayByChain = new Map<number, LeaderboardTodayTraderRow[]>();
    for (const row of args.yesterdayRows) {
      if (!args.showSystem && row.isSystemAddress) continue;
      const list = yesterdayByChain.get(row.chainId);
      if (list) {
        list.push(row);
      } else {
        yesterdayByChain.set(row.chainId, [row]);
      }
    }
    for (const chainId of degradedChains) {
      const snap = degradedSnapshotByChain.get(chainId);
      // Match firstDay row by (chainId, snapshotDay) — the isolated
      // query and the primary query both use `distinct_on: [chainId]`
      // ordered by `snapshotDay desc`, so they'll converge on the same
      // snapshotDay per chain in steady state. Defensive lookup
      // handles brief mismatches around heartbeat boundaries.
      const firstDay = snap
        ? firstDayBySnapshotKey.get(`${chainId}-${snap.snapshotDay}`)
        : undefined;
      if (!snap || !firstDay) {
        // First-day slice not available for this chain — keep
        // degraded rather than fall back to a partial subtraction
        // (which could be inconsistent with the primary snapshot).
        remainingDegradedChains.push(chainId);
        continue;
      }
      // Slice subtraction off the snapshot. Use the same showSystem
      // branch the snapshot was added under so the units match. Even
      // when yesterday has zero rows for this chain, subtracting the
      // first-day slice is correct: it slides the window forward by
      // one day with a zero contribution from yesterday.
      if (args.showSystem) {
        totalVolumeUsdWei -= BigInt(
          firstDay.firstDayVolumeUsdWeiIncludingSystem,
        );
        totalSwapCount -= firstDay.firstDaySwapCountIncludingSystem;
        uniqueFromSnapshot -=
          firstDay.firstDayExclusiveUniqueTradersIncludingSystem;
      } else {
        totalVolumeUsdWei -= BigInt(firstDay.firstDayVolumeUsdWei);
        totalSwapCount -= firstDay.firstDaySwapCount;
        uniqueFromSnapshot -= firstDay.firstDayExclusiveUniqueTraders;
      }
      // Add yesterday's rows for this chain (may be empty).
      const yRows = yesterdayByChain.get(chainId);
      if (yRows && yRows.length > 0) {
        const yesterdayTradersForChain = new Set<string>();
        for (const row of yRows) {
          totalVolumeUsdWei += BigInt(row.volumeUsdWei);
          totalSwapCount += row.swapCount;
          yesterdayTradersForChain.add(row.trader);
          partialTraderKeys.add(traderKey(row.chainId, row.trader));
        }
        yesterdayUniqueTradersAdded += yesterdayTradersForChain.size;
      }
      // Chain has been supplemented (with zero or more yesterday
      // rows), so it drops out of `degradedChains`.
    }
  } else {
    // First-day or yesterday query hasn't completed yet (or errored):
    // every degraded chain stays degraded.
    remainingDegradedChains.push(...degradedChains);
  }

  const overlapKeys =
    args.partialOverlapRows === undefined
      ? null
      : buildHistoricalOverlapKeys(args.partialOverlapRows, args.showSystem);
  const exactNewPartialTraders =
    overlapKeys === null
      ? null
      : Array.from(partialTraderKeys).filter((key) => !overlapKeys.has(key))
          .length;

  return {
    totalVolumeUsdWei,
    totalSwapCount,
    uniqueTraders:
      exactNewPartialTraders === null
        ? uniqueFromSnapshot + todayTraders.size + yesterdayUniqueTradersAdded
        : uniqueFromSnapshot + exactNewPartialTraders,
    staleChains,
    degradedChains: remainingDegradedChains,
  };
}

/**
 * Top-10 concentration ratio (top-10 traders' window-volume ÷ total
 * window-volume), as a percent (0–100, rounded to 1 dp at the call site).
 *
 * Stale-chain consistency: `totalVolumeUsdWei` (the denominator) is the
 * post-filter total from `mergeHeroSnapshot` — stale chains' snapshot
 * volume AND their today's partial are already excluded. The numerator
 * applies the same chain mask, otherwise a stale chain's pre-silence
 * trader-day rows would count toward the top-10 sum while its
 * window-volume is dropped from the total, producing ratios that can
 * exceed 100%, or 0.0% over a zero denominator while the table still
 * has volume. We pick the top-10 traders ON FRESH+DEGRADED CHAINS
 * (skipping any row whose `chainId` is in `staleChains`), so the
 * numerator and denominator describe the same effective population.
 *
 * Degraded chains are NOT skipped: their snapshot is kept in the
 * denominator (one closed day missing is acceptable noise), so their
 * trader rows belong in the numerator too.
 *
 * Returns 0 when there are no rows or the denominator is zero — the
 * caller (the Top-10 tile) renders a `—` for empty/error/loading states
 * separately, so 0 here means "computed, but nothing to concentrate".
 */
export function top10Concentration(args: {
  rowsByVolumeDesc: ReadonlyArray<{ chainId: number; volumeUsdWei: bigint }>;
  totalVolumeUsdWei: bigint;
  staleChains: ReadonlyArray<number>;
}): number {
  if (
    args.rowsByVolumeDesc.length === 0 ||
    args.totalVolumeUsdWei === BigInt(0)
  )
    return 0;
  const staleChainSet = new Set(args.staleChains);
  let top10 = BigInt(0);
  let consumed = 0;
  for (const row of args.rowsByVolumeDesc) {
    if (staleChainSet.has(row.chainId)) continue;
    top10 += row.volumeUsdWei;
    consumed += 1;
    if (consumed >= 10) break;
  }
  return Number((top10 * BigInt(10000)) / args.totalVolumeUsdWei) / 100;
}
