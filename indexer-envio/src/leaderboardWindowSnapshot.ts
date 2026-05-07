// Pure-function helpers for the LeaderboardWindowSnapshot heartbeat flush.
// Kept context-free so they're unit-testable without Envio's mockDb (which
// hides multi-id `set()` within a single handler — see
// reference_envio_mockdb_intra_handler).
//
// The async flush wrappers and heartbeat trigger live in
// leaderboardWindowFlush.ts; they wire these pure pieces to the
// TraderDailySnapshot / BrokerTraderDailySnapshot / Leaderboard*State
// entity tables.

import type { LeaderboardWindowSnapshot } from "generated";
import { SECONDS_PER_DAY } from "./helpers";

// Mirror of `LeaderboardRangeKey` in
// `ui-dashboard/src/lib/leaderboard.ts` — duplicated because the
// indexer and dashboard packages don't share types.
export type WindowKey = "24h" | "7d" | "30d" | "all";

export const WINDOW_KEYS: ReadonlyArray<WindowKey> = [
  "24h",
  "7d",
  "30d",
  "all",
];

/** Lookback length per window in days. `null` for "all" (no lower bound). */
export const WINDOW_DAYS: Readonly<Record<WindowKey, number | null>> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
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
 *  (chainId, snapshotDay, windowKey) by aggregatePerWindow. */
export interface TraderWindowAggregate {
  trader: string;
  volumeUsdWei: bigint;
  swapCount: number;
  isSystemAddress: boolean;
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
 *  cross-chain rows are dropped (defensive: getWhere.chainId.eq() can
 *  surface rows the caller doesn't want under some Envio Map-index
 *  internals; see the cargo-culted check in handlers/feeToken.ts). */
export function aggregatePerWindow(
  rows: ReadonlyArray<TraderDailyRow>,
  chainId: number,
  snapshotDay: bigint,
): Record<WindowKey, TraderWindowAggregate[]> {
  const out = {} as Record<WindowKey, TraderWindowAggregate[]>;
  for (const w of WINDOW_KEYS) {
    const start = windowStartDay(snapshotDay, w);
    const byTrader = new Map<string, TraderWindowAggregate>();
    for (const r of rows) {
      if (r.chainId !== chainId) continue;
      if (r.timestamp < start) continue;
      if (r.timestamp > snapshotDay) continue;
      const existing = byTrader.get(r.trader);
      if (existing) {
        existing.volumeUsdWei += r.volumeUsdWei;
        existing.swapCount += r.swapCount;
        // Sticky-true: a trader flagged system on any day stays system in
        // the window aggregate. Mirrors TraderDailySnapshot's per-day rule.
        existing.isSystemAddress =
          existing.isSystemAddress || r.isSystemAddress;
      } else {
        byTrader.set(r.trader, {
          trader: r.trader,
          volumeUsdWei: r.volumeUsdWei,
          swapCount: r.swapCount,
          isSystemAddress: r.isSystemAddress,
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
 *  fields keep the all-up totals for the toggle-on case. */
export function buildLeaderboardWindowSnapshot(
  args: BuildSnapshotArgs,
): LeaderboardWindowSnapshot {
  let totalVolumeUsdWei = 0n;
  let totalVolumeUsdWeiIncludingSystem = 0n;
  let totalSwapCount = 0;
  let totalSwapCountIncludingSystem = 0;
  let nonSystemCount = 0;
  for (const a of args.aggregates) {
    totalVolumeUsdWeiIncludingSystem += a.volumeUsdWei;
    totalSwapCountIncludingSystem += a.swapCount;
    if (!a.isSystemAddress) {
      totalVolumeUsdWei += a.volumeUsdWei;
      totalSwapCount += a.swapCount;
      nonSystemCount += 1;
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
    blockNumber: args.blockNumber,
    updatedAtTimestamp: args.updatedAtTimestamp,
  };
}
