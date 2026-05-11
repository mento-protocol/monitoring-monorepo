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

/** Wire shape of the isolated exact trader-set query. Optional in the
 *  merge path: if the query is unavailable during schema rollout, callers
 *  keep the legacy count-based approximation. */
export type LeaderboardWindowTraderSetRow = {
  chainId: number;
  snapshotDay: string;
  traders: string[];
  tradersIncludingSystem: string[];
  firstDayExclusiveTraders: string[];
  firstDayExclusiveTradersIncludingSystem: string[];
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

function buildTraderSetSnapshotKeyMap(
  rows: ReadonlyArray<LeaderboardWindowTraderSetRow>,
): Map<string, LeaderboardWindowTraderSetRow> {
  const m = new Map<string, LeaderboardWindowTraderSetRow>();
  for (const row of rows) {
    m.set(`${row.chainId}-${row.snapshotDay}`, row);
  }
  return m;
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
 * The unique-trader count uses exact snapshot trader arrays when the
 * isolated trader-set query has landed. During schema rollout or query
 * failure it falls back to the legacy count-based path, which adds
 * snapshot + yesterday + today counts without cross-source de-duping.
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
 * Unique-trader precision: with `traderSetRows`, the catch-up deletes
 * first-day-exclusive traders from the snapshot set, then unions
 * yesterday + today so overlap across all three sources is exact. Without
 * `traderSetRows`, the fallback count path remains approximate; volume and
 * swap counts are exact through slice subtraction either way.
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
  /** Exact per-window trader sets for the same (chainId, snapshotDay)
   *  tuples as `snapshotRows`. Lives in an isolated query so schema lag
   *  degrades only unique-trader precision; volume/swap totals and the
   *  legacy count fallback continue to render. */
  traderSetRows?: ReadonlyArray<LeaderboardWindowTraderSetRow> | undefined;
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
  const exactTraders = new Set<string>();
  const traderSetBySnapshotKey = args.traderSetRows
    ? buildTraderSetSnapshotKeyMap(args.traderSetRows)
    : null;
  let canUseExactTraderSets = traderSetBySnapshotKey !== null;
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
    const traderSet = traderSetBySnapshotKey?.get(
      `${row.chainId}-${row.snapshotDay}`,
    );
    if (canUseExactTraderSets && !traderSet) {
      canUseExactTraderSets = false;
    }
    if (traderSet) {
      const traders = args.showSystem
        ? traderSet.tradersIncludingSystem
        : traderSet.traders;
      for (const trader of traders) {
        exactTraders.add(`${row.chainId}-${trader}`);
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
    const key = `${row.chainId}-${row.trader}`;
    todayTraders.add(key);
    if (canUseExactTraderSets) exactTraders.add(key);
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
      if (canUseExactTraderSets) {
        const traderSet = traderSetBySnapshotKey?.get(
          `${chainId}-${snap.snapshotDay}`,
        );
        const firstDayExclusive = args.showSystem
          ? traderSet?.firstDayExclusiveTradersIncludingSystem
          : traderSet?.firstDayExclusiveTraders;
        if (!firstDayExclusive) {
          canUseExactTraderSets = false;
        } else {
          for (const trader of firstDayExclusive) {
            exactTraders.delete(`${chainId}-${trader}`);
          }
        }
      }
      // Add yesterday's rows for this chain (may be empty).
      const yRows = yesterdayByChain.get(chainId);
      if (yRows && yRows.length > 0) {
        const yesterdayTradersForChain = new Set<string>();
        for (const row of yRows) {
          totalVolumeUsdWei += BigInt(row.volumeUsdWei);
          totalSwapCount += row.swapCount;
          yesterdayTradersForChain.add(row.trader);
          if (canUseExactTraderSets) {
            exactTraders.add(`${row.chainId}-${row.trader}`);
          }
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

  return {
    totalVolumeUsdWei,
    totalSwapCount,
    uniqueTraders: canUseExactTraderSets
      ? exactTraders.size
      : uniqueFromSnapshot + todayTraders.size + yesterdayUniqueTradersAdded,
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
