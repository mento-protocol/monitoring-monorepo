"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import {
  BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS,
  BROKER_LEADERBOARD_TODAY_TRADERS,
  BROKER_LEADERBOARD_WINDOW_FIRSTDAY_LATEST,
  BROKER_LEADERBOARD_WINDOW_LATEST,
  BROKER_LEADERBOARD_YESTERDAY_TRADERS,
  LEADERBOARD_PARTIAL_OVERLAP_TRADERS,
  LEADERBOARD_TODAY_TRADERS,
  LEADERBOARD_WINDOW_FIRSTDAY_LATEST,
  LEADERBOARD_WINDOW_LATEST,
  LEADERBOARD_YESTERDAY_TRADERS,
} from "@/lib/queries/leaderboard";
import {
  BrokerLeaderboardPartialOverlapTradersSchema,
  BrokerLeaderboardTodayTradersSchema,
  BrokerLeaderboardWindowFirstDayLatestSchema,
  BrokerLeaderboardWindowLatestSchema,
  BrokerLeaderboardYesterdayTradersSchema,
  LeaderboardPartialOverlapTradersSchema,
  LeaderboardTodayTradersSchema,
  LeaderboardWindowFirstDayLatestSchema,
  LeaderboardWindowLatestSchema,
  LeaderboardYesterdayTradersSchema,
} from "@/lib/queries/leaderboard-schemas";
import {
  buildHeroPartialOverlapQueryInput,
  mergeHeroSnapshot,
  top10Concentration,
  weiToUsd,
  type LeaderboardRangeKey,
  type LeaderboardPartialOverlapRow,
  type LeaderboardTodayTraderRow,
  type LeaderboardWindowFirstDayRow,
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
export function useHeroRollup({
  venue,
  range,
  showSystem,
  isSystemAddressIn,
  utcDayKey,
  kpiSource,
}: {
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
  }>(
    venue === "v3" ? LEADERBOARD_WINDOW_LATEST : null,
    { windowKey: range },
    undefined,
    {
      schema: LeaderboardWindowLatestSchema,
    },
  );
  const heroV2Result = useGQL<{
    BrokerLeaderboardWindowSnapshot: LeaderboardWindowRow[];
  }>(
    venue === "v2" ? BROKER_LEADERBOARD_WINDOW_LATEST : null,
    { windowKey: range },
    undefined,
    { schema: BrokerLeaderboardWindowLatestSchema },
  );

  // Today's UTC midnight in seconds. The hero snapshot's upper bound is
  // yesterday, so today's TraderDailySnapshot rows fill in the gap.
  // Memoised on `utcDayKey` so it flips at midnight without retriggering
  // every minute.
  const todayMidnight = useMemo(
    () => Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY,
    [utcDayKey],
  );
  const todayV3Result = useGQL<{
    TraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(
    venue === "v3" ? LEADERBOARD_TODAY_TRADERS : null,
    { todayMidnight, isSystemAddressIn },
    undefined,
    { schema: LeaderboardTodayTradersSchema },
  );
  const todayV2Result = useGQL<{
    BrokerTraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(
    venue === "v2" ? BROKER_LEADERBOARD_TODAY_TRADERS : null,
    { todayMidnight, isSystemAddressIn },
    undefined,
    { schema: BrokerLeaderboardTodayTradersSchema },
  );

  const snapshotRows =
    venue === "v3"
      ? heroV3Result.data?.LeaderboardWindowSnapshot
      : heroV2Result.data?.BrokerLeaderboardWindowSnapshot;
  const todayPartialRows =
    venue === "v3"
      ? todayV3Result.data?.TraderDailySnapshot
      : todayV2Result.data?.BrokerTraderDailySnapshot;

  // Isolated first-day slice query (split from the primary hero query so
  // a hosted-Hasura schema lag on the new `firstDay*` columns degrades
  // ONLY the catch-up — chains stay degraded — instead of failing the
  // primary hero query). Joined client-side by `chainId-snapshotDay` in
  // `mergeHeroSnapshot`.
  const heroFirstDayV3Result = useGQL<{
    LeaderboardWindowSnapshot: LeaderboardWindowFirstDayRow[];
  }>(
    venue === "v3" ? LEADERBOARD_WINDOW_FIRSTDAY_LATEST : null,
    { windowKey: range },
    undefined,
    { schema: LeaderboardWindowFirstDayLatestSchema },
  );
  const heroFirstDayV2Result = useGQL<{
    BrokerLeaderboardWindowSnapshot: LeaderboardWindowFirstDayRow[];
  }>(
    venue === "v2" ? BROKER_LEADERBOARD_WINDOW_FIRSTDAY_LATEST : null,
    { windowKey: range },
    undefined,
    { schema: BrokerLeaderboardWindowFirstDayLatestSchema },
  );
  const firstDayRows =
    venue === "v3"
      ? heroFirstDayV3Result.data?.LeaderboardWindowSnapshot
      : heroFirstDayV2Result.data?.BrokerLeaderboardWindowSnapshot;

  // First-pass merge — without `yesterdayRows`. Used solely to discover
  // which chains are in the DEGRADED state (snapshotDay = today - 2 days),
  // so we can gate the yesterday-traders query on them. Cheap (one
  // O(snapshotRows + todayRows) pass).
  const degradedChainsForGate = useMemo(
    () =>
      mergeHeroSnapshot({
        snapshotRows,
        todayRows: todayPartialRows,
        showSystem,
        todayMidnightSeconds: todayMidnight,
      }).degradedChains,
    [snapshotRows, todayPartialRows, showSystem, todayMidnight],
  );

  // Catch-up query for DEGRADED chains: fetches yesterday's trader-day
  // rows scoped to the degraded chainIds so the second merge pass can
  // perform slice subtraction (drop the snapshot's first day, add
  // yesterday + today). Gated on `degradedChainsForGate.length > 0` via
  // `useGQL`'s null-passthrough so we don't burn Envio quota when no
  // chain needs catching up.
  const yesterdayMidnight = todayMidnight - SECONDS_PER_DAY;
  const yesterdayV3Result = useGQL<{
    TraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(
    venue === "v3" && degradedChainsForGate.length > 0
      ? LEADERBOARD_YESTERDAY_TRADERS
      : null,
    { yesterdayMidnight, isSystemAddressIn, chainIdIn: degradedChainsForGate },
    undefined,
    { schema: LeaderboardYesterdayTradersSchema },
  );
  const yesterdayV2Result = useGQL<{
    BrokerTraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(
    venue === "v2" && degradedChainsForGate.length > 0
      ? BROKER_LEADERBOARD_YESTERDAY_TRADERS
      : null,
    { yesterdayMidnight, isSystemAddressIn, chainIdIn: degradedChainsForGate },
    undefined,
    { schema: BrokerLeaderboardYesterdayTradersSchema },
  );
  const yesterdayPartialRows =
    venue === "v3"
      ? yesterdayV3Result.data?.TraderDailySnapshot
      : yesterdayV2Result.data?.BrokerTraderDailySnapshot;

  const partialOverlapInput = useMemo(
    () =>
      buildHeroPartialOverlapQueryInput({
        snapshotRows,
        todayRows: todayPartialRows,
        firstDayRows,
        yesterdayRows: yesterdayPartialRows,
        showSystem,
        todayMidnightSeconds: todayMidnight,
        traderField: venue === "v2" ? "caller" : "trader",
      }),
    [
      snapshotRows,
      todayPartialRows,
      firstDayRows,
      yesterdayPartialRows,
      showSystem,
      todayMidnight,
      venue,
    ],
  );
  const partialOverlapV3Result = useGQL<{
    TraderDailySnapshot: LeaderboardPartialOverlapRow[];
  }>(
    venue === "v3" && partialOverlapInput
      ? LEADERBOARD_PARTIAL_OVERLAP_TRADERS
      : null,
    partialOverlapInput ?? { where: { _or: [] }, limit: 0 },
    undefined,
    { timeoutMs: 8_000, schema: LeaderboardPartialOverlapTradersSchema },
  );
  const partialOverlapV2Result = useGQL<{
    BrokerTraderDailySnapshot: LeaderboardPartialOverlapRow[];
  }>(
    venue === "v2" && partialOverlapInput
      ? BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS
      : null,
    partialOverlapInput ?? { where: { _or: [] }, limit: 0 },
    undefined,
    { timeoutMs: 8_000, schema: BrokerLeaderboardPartialOverlapTradersSchema },
  );
  const partialOverlapRows =
    partialOverlapInput === null
      ? []
      : partialOverlapInput === undefined
        ? undefined
        : venue === "v3"
          ? partialOverlapV3Result.data?.TraderDailySnapshot
          : partialOverlapV2Result.data?.BrokerTraderDailySnapshot;

  const heroTotals = useMemo(
    () =>
      mergeHeroSnapshot({
        snapshotRows,
        todayRows: todayPartialRows,
        firstDayRows,
        yesterdayRows: yesterdayPartialRows,
        partialOverlapRows,
        showSystem,
        todayMidnightSeconds: todayMidnight,
      }),
    [
      snapshotRows,
      todayPartialRows,
      firstDayRows,
      yesterdayPartialRows,
      partialOverlapRows,
      showSystem,
      todayMidnight,
    ],
  );
  const totalVolume = useMemo(
    () => weiToUsd(heroTotals.totalVolumeUsdWei),
    [heroTotals.totalVolumeUsdWei],
  );

  // Stale-chain mask is applied to numerator AND denominator in
  // `top10Concentration` — denominator already excludes them via
  // `mergeHeroSnapshot` — see that helper's JSDoc in `lib/leaderboard.ts`.
  const concentration = useMemo(
    () =>
      top10Concentration({
        rowsByVolumeDesc: kpiSource,
        totalVolumeUsdWei: heroTotals.totalVolumeUsdWei,
        staleChains: heroTotals.staleChains,
      }),
    [kpiSource, heroTotals.totalVolumeUsdWei, heroTotals.staleChains],
  );

  // Tiles + chart load when the hero snapshot AND its today-partial both
  // land. The top-50 table loads independently from the existing
  // TraderDailySnapshot query (which is fast — capped at 1000 by design).
  const isLoading =
    venue === "v3"
      ? heroV3Result.isLoading || todayV3Result.isLoading
      : heroV2Result.isLoading || todayV2Result.isLoading;
  const hasError =
    venue === "v3"
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
