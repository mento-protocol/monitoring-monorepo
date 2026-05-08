// Pure-function helpers for the LeaderboardWindowSnapshot heartbeat flush.
// Kept context-free so they're unit-testable as pure functions, independent
// of any Envio test indexer plumbing.
//
// The async flush wrappers and heartbeat trigger live in
// leaderboardWindowFlush.ts; they wire these pure pieces to the
// TraderDailySnapshot / BrokerTraderDailySnapshot / Leaderboard*State
// entity tables.

import type { LeaderboardWindowSnapshot } from "envio";
import { SECONDS_PER_DAY } from "./helpers.js";

// Mirror of `LeaderboardRangeKey` in
// `ui-dashboard/src/lib/leaderboard.ts` — duplicated because the
// indexer and dashboard packages don't share types.
export type WindowKey = "24h" | "7d" | "30d" | "90d" | "all";

export const WINDOW_KEYS: ReadonlyArray<WindowKey> = [
  "24h",
  "7d",
  "30d",
  "90d",
  "all",
];

/** Lookback length per window in days. `null` for "all" (no lower bound). */
export const WINDOW_DAYS: Readonly<Record<WindowKey, number | null>> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

/** UTC-midnight start-of-window for a given snapshotDay + windowKey.
 *
 *  The snapshot covers `[windowStartDay, snapshotDay]` (inclusive — both
 *  ends are UTC day buckets). The dashboard adds today's partial (one
 *  more day) on top, so the snapshot's job is to cover exactly
 *  `windowDays - 1` closed days. With `snapshotDay = yesterday`:
 *
 *    24h (1 day total)  → snapshot empty,           today provides 1 day
 *    7d  (7 days total) → snapshot covers 6 closed, today provides 1 day
 *    30d (30 days)      → snapshot covers 29 closed, today provides 1 day
 *    all                → snapshot covers everything from epoch
 *
 *  Returning `snapshotDay + 1 day` for 24h yields an empty inclusive range
 *  (`[snapshotDay+1, snapshotDay]`) so no rows pass the filter — correct
 *  by construction. */
export function windowStartDay(
  snapshotDay: bigint,
  windowKey: WindowKey,
): bigint {
  const days = WINDOW_DAYS[windowKey];
  if (days === null) return 0n;
  if (days <= 1) return snapshotDay + SECONDS_PER_DAY;
  return snapshotDay - BigInt(days - 2) * SECONDS_PER_DAY;
}

/** Per-trader summed totals over a window. Built once per
 *  (chainId, snapshotDay, windowKey) by aggregatePerWindow.
 *
 *  `firstDayVolumeUsdWei` / `firstDaySwapCount` / `activeOutsideFirstDay`
 *  expose the first-day slice (rows where `timestamp ===
 *  windowStartDay`) so the snapshot can ship a `firstDay*` field set
 *  the dashboard uses for slice subtraction in the DEGRADED-chain
 *  catch-up path. Always zero / true (resp.) for `all` and `24h`
 *  windows because their first-day boundary is undefined / outside
 *  the inclusive range. */
export interface TraderWindowAggregate {
  trader: string;
  volumeUsdWei: bigint;
  swapCount: number;
  isSystemAddress: boolean;
  /** Volume contributed on `windowStartDay` only. 0 outside that day. */
  firstDayVolumeUsdWei: bigint;
  /** Swap count on `windowStartDay` only. 0 outside that day. */
  firstDaySwapCount: number;
  /** True if the trader has ANY row at `timestamp > windowStartDay`
   *  inside the window. Used to compute the
   *  `firstDayExclusiveUniqueTraders` count: traders whose entire
   *  window activity is on the first day have `false` here. */
  activeOutsideFirstDay: boolean;
}

/** Minimal subset of TraderDailySnapshot / BrokerTraderDailySnapshot fields
 *  the aggregator needs. Both v3 and v2 entity types are structurally
 *  compatible with this. */
export interface TraderDailyRow {
  chainId: number;
  trader: string;
  timestamp: bigint;
  volumeUsdWei: bigint;
  swapCount: number;
  isSystemAddress: boolean;
}

/** Group raw daily-snapshot rows by trader, summed across each window's
 *  [windowStartDay, snapshotDay] inclusive range. Out-of-range and
 *  cross-chain rows are dropped defensively in case `getWhere({chainId:
 *  {_eq:n}})` ever surfaces rows the caller doesn't want under Envio's
 *  index internals — same belt-and-suspenders pattern used in
 *  handlers/feeToken.ts.
 *
 *  Also tracks per-trader first-day slice (volume + swap count on
 *  `windowStartDay`) and an `activeOutsideFirstDay` flag so the snapshot
 *  builder can ship the `firstDay*` slice fields the DEGRADED-chain
 *  dashboard catch-up needs. For `all` and `24h` windows the first-day
 *  fields are forced to neutral values (0 volume, 0 count, `true`
 *  activeOutsideFirstDay) — `all` has no first-day boundary and `24h`
 *  has an empty inclusive range. */
export function aggregatePerWindow(
  rows: ReadonlyArray<TraderDailyRow>,
  chainId: number,
  snapshotDay: bigint,
): Record<WindowKey, TraderWindowAggregate[]> {
  const out = {} as Record<WindowKey, TraderWindowAggregate[]>;
  for (const w of WINDOW_KEYS) {
    const start = windowStartDay(snapshotDay, w);
    const byTrader = new Map<string, TraderWindowAggregate>();
    // The "first day" only makes sense for windows with a real lower
    // bound that overlaps the data: `7d` / `30d` / `90d`. `all` returns
    // 0n (epoch) — all real rows are >= start, none equal start, so the
    // first-day slice is empty by definition. `24h` returns
    // `snapshotDay + 1`, an empty range above the upper bound, so the
    // slice is empty too. We force the firstDay* fields off for those
    // windows below.
    const days = WINDOW_DAYS[w];
    const hasFirstDayBoundary = days !== null && days > 1;
    for (const r of rows) {
      if (r.chainId !== chainId) continue;
      if (r.timestamp < start) continue;
      if (r.timestamp > snapshotDay) continue;
      const isFirstDay = hasFirstDayBoundary && r.timestamp === start;
      const existing = byTrader.get(r.trader);
      if (existing) {
        existing.volumeUsdWei += r.volumeUsdWei;
        existing.swapCount += r.swapCount;
        // Sticky-true: a trader flagged system on any day stays system in
        // the window aggregate. Mirrors TraderDailySnapshot's per-day rule.
        existing.isSystemAddress =
          existing.isSystemAddress || r.isSystemAddress;
        if (isFirstDay) {
          existing.firstDayVolumeUsdWei += r.volumeUsdWei;
          existing.firstDaySwapCount += r.swapCount;
        } else {
          existing.activeOutsideFirstDay = true;
        }
      } else {
        byTrader.set(r.trader, {
          trader: r.trader,
          volumeUsdWei: r.volumeUsdWei,
          swapCount: r.swapCount,
          isSystemAddress: r.isSystemAddress,
          firstDayVolumeUsdWei: isFirstDay ? r.volumeUsdWei : 0n,
          firstDaySwapCount: isFirstDay ? r.swapCount : 0,
          // For windows without a first-day boundary (`all` / `24h`),
          // mark every trader `activeOutsideFirstDay = true` so the
          // exclusive-traders count is naturally zero — the slice
          // subtraction is a no-op there, which is correct.
          activeOutsideFirstDay: !hasFirstDayBoundary || !isFirstDay,
        });
      }
    }
    out[w] = Array.from(byTrader.values());
  }
  return out;
}

export interface BuildSnapshotArgs {
  chainId: number;
  windowKey: WindowKey;
  snapshotDay: bigint;
  windowStartDay: bigint;
  aggregates: ReadonlyArray<TraderWindowAggregate>;
  blockNumber: bigint;
  updatedAtTimestamp: bigint;
}

/** Build a single LeaderboardWindowSnapshot row from per-trader aggregates.
 *  Same shape works for v2 (BrokerLeaderboardWindowSnapshot) — the field set
 *  is identical (see schema.graphql). `aggregatePerWindow` already dedupes
 *  per-trader, so each entry in `aggregates` is one unique trader. The
 *  primary `total*` fields exclude system addresses to match the dashboard's
 *  default "Show system addresses = off" view; sibling `*IncludingSystem`
 *  fields keep the all-up totals for the toggle-on case.
 *
 *  The `firstDay*` fields ship the snapshot's `windowStartDay` slice so
 *  the dashboard can drop the boundary day when supplementing a
 *  DEGRADED chain's hero KPIs with a yesterday-rows query — see
 *  `mergeHeroSnapshot` in `ui-dashboard/src/lib/leaderboard-hero.ts`.
 *  `firstDayExclusiveUniqueTraders` counts traders whose entire window
 *  activity falls on the first day; subtracting it from `uniqueTraders`
 *  yields the trader count for the inner `[windowStartDay+1,
 *  snapshotDay]` slice without needing a per-trader set on the wire. */
export function buildLeaderboardWindowSnapshot(
  args: BuildSnapshotArgs,
): LeaderboardWindowSnapshot {
  let totalVolumeUsdWei = 0n;
  let totalVolumeUsdWeiIncludingSystem = 0n;
  let totalSwapCount = 0;
  let totalSwapCountIncludingSystem = 0;
  let nonSystemCount = 0;
  let firstDayVolumeUsdWei = 0n;
  let firstDayVolumeUsdWeiIncludingSystem = 0n;
  let firstDaySwapCount = 0;
  let firstDaySwapCountIncludingSystem = 0;
  let firstDayExclusiveUniqueTraders = 0;
  let firstDayExclusiveUniqueTradersIncludingSystem = 0;
  for (const a of args.aggregates) {
    totalVolumeUsdWeiIncludingSystem += a.volumeUsdWei;
    totalSwapCountIncludingSystem += a.swapCount;
    firstDayVolumeUsdWeiIncludingSystem += a.firstDayVolumeUsdWei;
    firstDaySwapCountIncludingSystem += a.firstDaySwapCount;
    if (!a.activeOutsideFirstDay) {
      firstDayExclusiveUniqueTradersIncludingSystem += 1;
    }
    if (!a.isSystemAddress) {
      totalVolumeUsdWei += a.volumeUsdWei;
      totalSwapCount += a.swapCount;
      nonSystemCount += 1;
      firstDayVolumeUsdWei += a.firstDayVolumeUsdWei;
      firstDaySwapCount += a.firstDaySwapCount;
      if (!a.activeOutsideFirstDay) {
        firstDayExclusiveUniqueTraders += 1;
      }
    }
  }
  return {
    id: `${args.chainId}-${args.windowKey}-${args.snapshotDay}`,
    chainId: args.chainId,
    windowKey: args.windowKey,
    snapshotDay: args.snapshotDay,
    windowStartDay: args.windowStartDay,
    totalVolumeUsdWei,
    totalVolumeUsdWeiIncludingSystem,
    totalSwapCount,
    totalSwapCountIncludingSystem,
    uniqueTraders: nonSystemCount,
    uniqueTradersIncludingSystem: args.aggregates.length,
    firstDayVolumeUsdWei,
    firstDayVolumeUsdWeiIncludingSystem,
    firstDaySwapCount,
    firstDaySwapCountIncludingSystem,
    firstDayExclusiveUniqueTraders,
    firstDayExclusiveUniqueTradersIncludingSystem,
    blockNumber: args.blockNumber,
    updatedAtTimestamp: args.updatedAtTimestamp,
  };
}
