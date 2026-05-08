"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import {
  BROKER_LEADERBOARD_TODAY_TRADERS,
  BROKER_LEADERBOARD_WINDOW_LATEST,
  LEADERBOARD_TODAY_TRADERS,
  LEADERBOARD_WINDOW_LATEST,
} from "@/lib/queries/leaderboard";
import {
  mergeHeroSnapshot,
  top10Concentration,
  weiToUsd,
  type LeaderboardRangeKey,
  type LeaderboardTodayTraderRow,
  type LeaderboardWindowRow,
} from "@/lib/leaderboard";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import type { Venue } from "./url-state";

/**
 * Hero-tile data slice for the leaderboard page (total volume, unique
 * traders, total swaps, top-10 concentration, plus the stale/degraded
 * chain lists that drive the data-quality banners).
 *
 * Owns:
 *   - the pre-rolled `LeaderboardWindowSnapshot` query (v3) +
 *     `BrokerLeaderboardWindowSnapshot` (v2);
 *   - today's small partial (`LEADERBOARD_TODAY_TRADERS` /
 *     `BROKER_LEADERBOARD_TODAY_TRADERS`) used to fill the gap between
 *     the snapshot's `[windowStart, yesterday]` upper bound and the
 *     current minute;
 *   - the `todayMidnight` memo that flips at UTC midnight (driven by
 *     `utcDayKey`);
 *   - `mergeHeroSnapshot` (totals + stale/degraded chain detection) and
 *     the `top10Concentration` denominator share. The numerator's
 *     top-50 source comes from the parent (`kpiSource`) — this hook
 *     intentionally doesn't pull in the trader/aggregator queries.
 *
 * Lives in its own file so `page-client.tsx` stays under the 600-line
 * soft cap (see repo-root AGENTS.md "File-size budget"). The hero data
 * slice is small but its derivation chain is dense — naming the slice
 * keeps the parent client readable.
 */
export function useHeroRollup(args: {
  venue: Venue;
  range: LeaderboardRangeKey;
  showSystem: boolean;
  isSystemAddressIn: ReadonlyArray<boolean>;
  utcDayKey: number;
  /** Source list for top-10 concentration's numerator (top-50 paginated
   *  per-day query). The parent owns this query; the hook only consumes
   *  the resulting rows so the table query and the hero query can degrade
   *  independently. */
  kpiSource: ReadonlyArray<{ chainId: number; volumeUsdWei: bigint }>;
}): {
  /** Memoised UTC midnight in seconds — flips at UTC day rollover via
   *  `utcDayKey`. Re-exposed so callers can pass it to other queries
   *  that pre-aggregate "today" partial data. */
  todayMidnight: number;
  totalVolume: number;
  totalTraders: number;
  totalSwaps: number;
  /** Concentration as a percent, `[0, 100]`. */
  concentration: number;
  staleChains: number[];
  degradedChains: number[];
  isLoading: boolean;
  hasError: boolean;
} {
  // Pre-rolled hero snapshot (one row per chain for the active window).
  // Bypasses Hasura's 1000-row cap on long windows. The snapshot covers
  // [windowStart, yesterday]; today's partial is fetched separately and
  // added client-side.
  const heroV3Result = useGQL<{
    LeaderboardWindowSnapshot: LeaderboardWindowRow[];
  }>(args.venue === "v3" ? LEADERBOARD_WINDOW_LATEST : null, {
    windowKey: args.range,
  });
  const heroV2Result = useGQL<{
    BrokerLeaderboardWindowSnapshot: LeaderboardWindowRow[];
  }>(args.venue === "v2" ? BROKER_LEADERBOARD_WINDOW_LATEST : null, {
    windowKey: args.range,
  });

  // Today's UTC midnight in seconds. The hero snapshot's upper bound is
  // yesterday, so today's TraderDailySnapshot rows fill in the gap.
  // Memoised on `utcDayKey` so it flips at midnight without retriggering
  // every minute.
  const todayMidnight = useMemo(
    () => Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY,
    [args.utcDayKey],
  );
  const todayV3Result = useGQL<{
    TraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(args.venue === "v3" ? LEADERBOARD_TODAY_TRADERS : null, {
    todayMidnight,
    isSystemAddressIn: args.isSystemAddressIn,
  });
  const todayV2Result = useGQL<{
    BrokerTraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(args.venue === "v2" ? BROKER_LEADERBOARD_TODAY_TRADERS : null, {
    todayMidnight,
    isSystemAddressIn: args.isSystemAddressIn,
  });

  const snapshotRows =
    args.venue === "v3"
      ? heroV3Result.data?.LeaderboardWindowSnapshot
      : heroV2Result.data?.BrokerLeaderboardWindowSnapshot;
  const todayPartialRows =
    args.venue === "v3"
      ? todayV3Result.data?.TraderDailySnapshot
      : todayV2Result.data?.BrokerTraderDailySnapshot;

  const heroTotals = useMemo(
    () =>
      mergeHeroSnapshot({
        snapshotRows,
        todayRows: todayPartialRows,
        showSystem: args.showSystem,
        todayMidnightSeconds: todayMidnight,
      }),
    [snapshotRows, todayPartialRows, args.showSystem, todayMidnight],
  );
  const totalVolume = useMemo(
    () => weiToUsd(heroTotals.totalVolumeUsdWei),
    [heroTotals.totalVolumeUsdWei],
  );

  // Source list for top-10 concentration's numerator (top-50 paginated
  // per-day query). Denominator is the exact snapshot total above. The
  // helper applies the same stale-chain mask to numerator AND denominator
  // so the ratio stays coherent when a chain is silent — see
  // `top10Concentration` JSDoc in `lib/leaderboard.ts` for the rationale.
  const concentration = useMemo(
    () =>
      top10Concentration({
        rowsByVolumeDesc: args.kpiSource,
        totalVolumeUsdWei: heroTotals.totalVolumeUsdWei,
        staleChains: heroTotals.staleChains,
      }),
    [args.kpiSource, heroTotals.totalVolumeUsdWei, heroTotals.staleChains],
  );

  // Tiles + chart load when the hero snapshot AND its today-partial both
  // land. The top-50 table loads independently from the existing
  // TraderDailySnapshot query (which is fast — capped at 1000 by design).
  const isLoading =
    args.venue === "v3"
      ? heroV3Result.isLoading || todayV3Result.isLoading
      : heroV2Result.isLoading || todayV2Result.isLoading;
  const hasError =
    args.venue === "v3"
      ? !!heroV3Result.error || !!todayV3Result.error
      : !!heroV2Result.error || !!todayV2Result.error;

  return {
    todayMidnight,
    totalVolume,
    totalTraders: heroTotals.uniqueTraders,
    totalSwaps: heroTotals.totalSwapCount,
    concentration,
    staleChains: heroTotals.staleChains,
    degradedChains: heroTotals.degradedChains,
    isLoading,
    hasError,
  };
}
