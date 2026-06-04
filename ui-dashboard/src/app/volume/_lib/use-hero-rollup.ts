"use client";

import { useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import {
  BROKER_VOLUME_PARTIAL_OVERLAP_TRADERS,
  BROKER_VOLUME_TODAY_TRADERS,
  BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST,
  BROKER_VOLUME_WINDOW_LATEST,
  BROKER_VOLUME_YESTERDAY_TRADERS,
  LEGACY_BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST,
  LEGACY_BROKER_VOLUME_WINDOW_LATEST,
  LEGACY_VOLUME_WINDOW_FIRSTDAY_LATEST,
  LEGACY_VOLUME_WINDOW_LATEST,
  VOLUME_PARTIAL_OVERLAP_TRADERS,
  VOLUME_TODAY_TRADERS,
  VOLUME_WINDOW_FIRSTDAY_LATEST,
  VOLUME_WINDOW_LATEST,
  VOLUME_YESTERDAY_TRADERS,
} from "@/lib/queries/volume";
import {
  BrokerVolumePartialOverlapTradersSchema,
  BrokerVolumeTodayTradersSchema,
  BrokerVolumeWindowFirstDayLatestSchema,
  BrokerVolumeWindowLatestSchema,
  BrokerVolumeYesterdayTradersSchema,
  VolumePartialOverlapTradersSchema,
  VolumeTodayTradersSchema,
  VolumeWindowFirstDayLatestSchema,
  VolumeWindowLatestSchema,
  VolumeYesterdayTradersSchema,
} from "@/lib/queries/volume-schemas";
import {
  buildHeroPartialOverlapQueryInput,
  mergeHeroSnapshot,
  top10Concentration,
  weiToUsd,
  type VolumeRangeKey,
  type VolumePartialOverlapRow,
  type VolumeTodayTraderRow,
  type VolumeWindowFirstDayRow,
  type VolumeWindowRow,
} from "@/lib/volume";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import type { Venue } from "./url-state";

type HeroV3Data = { volumeWindowSnapshots: VolumeWindowRow[] };
type HeroV2Data = { brokerVolumeWindowSnapshots: VolumeWindowRow[] };
type GqlState<T> = {
  data: T | undefined;
  isLoading: boolean;
  error: unknown;
};

/**
 * Hero-tile data slice for the volume page (total volume, unique
 * traders, total swaps, top-10 concentration, plus the stale/degraded
 * chain lists that drive the data-quality banners).
 *
 * Owns:
 *   - the pre-rolled volume snapshot queries for v3 and v2;
 *   - today's small partial (`VOLUME_TODAY_TRADERS` /
 *     `BROKER_VOLUME_TODAY_TRADERS`) used to fill the gap between
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
// eslint-disable-next-line complexity, max-lines-per-function, sonarjs/cognitive-complexity -- Existing hero rollup hook carried through this route rename; keep the waiver scoped instead of reseeding package baseline.
export function useHeroRollup({
  venue,
  range,
  showSystem,
  isSystemAddressIn,
  utcDayKey,
  kpiSource,
}: {
  venue: Venue;
  range: VolumeRangeKey;
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
  const heroV3Result = useGQL<HeroV3Data>(
    venue === "v3" ? VOLUME_WINDOW_LATEST : null,
    { windowKey: range },
    { schema: VolumeWindowLatestSchema },
  );
  const legacyHeroV3Result = useGQL<HeroV3Data>(
    venue === "v3" && heroV3Result.error && !heroV3Result.data
      ? LEGACY_VOLUME_WINDOW_LATEST
      : null,
    { windowKey: range },
    { schema: VolumeWindowLatestSchema },
  );
  const heroV2Result = useGQL<HeroV2Data>(
    venue === "v2" ? BROKER_VOLUME_WINDOW_LATEST : null,
    { windowKey: range },
    { schema: BrokerVolumeWindowLatestSchema },
  );
  const legacyHeroV2Result = useGQL<HeroV2Data>(
    venue === "v2" && heroV2Result.error && !heroV2Result.data
      ? LEGACY_BROKER_VOLUME_WINDOW_LATEST
      : null,
    { windowKey: range },
    { schema: BrokerVolumeWindowLatestSchema },
  );
  const heroV3Snapshot = preferPrimaryGqlResult(
    heroV3Result,
    legacyHeroV3Result,
  );
  const heroV2Snapshot = preferPrimaryGqlResult(
    heroV2Result,
    legacyHeroV2Result,
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
    volumeTodayTraders: VolumeTodayTraderRow[];
  }>(
    venue === "v3" ? VOLUME_TODAY_TRADERS : null,
    { todayMidnight, isSystemAddressIn },
    { schema: VolumeTodayTradersSchema },
  );
  const todayV2Result = useGQL<{
    brokerVolumeTodayTraders: VolumeTodayTraderRow[];
  }>(
    venue === "v2" ? BROKER_VOLUME_TODAY_TRADERS : null,
    { todayMidnight, isSystemAddressIn },
    { schema: BrokerVolumeTodayTradersSchema },
  );

  const snapshotRows =
    venue === "v3"
      ? heroV3Snapshot.data?.volumeWindowSnapshots
      : heroV2Snapshot.data?.brokerVolumeWindowSnapshots;
  const todayPartialRows =
    venue === "v3"
      ? todayV3Result.data?.volumeTodayTraders
      : todayV2Result.data?.brokerVolumeTodayTraders;

  // Isolated first-day slice query (split from the primary hero query so
  // a hosted-Hasura schema lag on the new `firstDay*` columns degrades
  // ONLY the catch-up — chains stay degraded — instead of failing the
  // primary hero query). Joined client-side by `chainId-snapshotDay` in
  // `mergeHeroSnapshot`.
  const heroFirstDayV3Result = useGQL<{
    volumeWindowFirstDaySnapshots: VolumeWindowFirstDayRow[];
  }>(
    venue === "v3" ? VOLUME_WINDOW_FIRSTDAY_LATEST : null,
    { windowKey: range },
    { schema: VolumeWindowFirstDayLatestSchema },
  );
  const legacyHeroFirstDayV3Result = useGQL<{
    volumeWindowFirstDaySnapshots: VolumeWindowFirstDayRow[];
  }>(
    venue === "v3" && heroFirstDayV3Result.error && !heroFirstDayV3Result.data
      ? LEGACY_VOLUME_WINDOW_FIRSTDAY_LATEST
      : null,
    { windowKey: range },
    { schema: VolumeWindowFirstDayLatestSchema },
  );
  const heroFirstDayV2Result = useGQL<{
    brokerVolumeWindowFirstDaySnapshots: VolumeWindowFirstDayRow[];
  }>(
    venue === "v2" ? BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST : null,
    { windowKey: range },
    { schema: BrokerVolumeWindowFirstDayLatestSchema },
  );
  const legacyHeroFirstDayV2Result = useGQL<{
    brokerVolumeWindowFirstDaySnapshots: VolumeWindowFirstDayRow[];
  }>(
    venue === "v2" && heroFirstDayV2Result.error && !heroFirstDayV2Result.data
      ? LEGACY_BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST
      : null,
    { windowKey: range },
    { schema: BrokerVolumeWindowFirstDayLatestSchema },
  );
  const heroFirstDayV3Snapshot = preferPrimaryGqlResult(
    heroFirstDayV3Result,
    legacyHeroFirstDayV3Result,
  );
  const heroFirstDayV2Snapshot = preferPrimaryGqlResult(
    heroFirstDayV2Result,
    legacyHeroFirstDayV2Result,
  );
  const firstDayRows =
    venue === "v3"
      ? heroFirstDayV3Snapshot.data?.volumeWindowFirstDaySnapshots
      : heroFirstDayV2Snapshot.data?.brokerVolumeWindowFirstDaySnapshots;

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
    volumeYesterdayTraders: VolumeTodayTraderRow[];
  }>(
    venue === "v3" && degradedChainsForGate.length > 0
      ? VOLUME_YESTERDAY_TRADERS
      : null,
    { yesterdayMidnight, isSystemAddressIn, chainIdIn: degradedChainsForGate },
    { schema: VolumeYesterdayTradersSchema },
  );
  const yesterdayV2Result = useGQL<{
    brokerVolumeYesterdayTraders: VolumeTodayTraderRow[];
  }>(
    venue === "v2" && degradedChainsForGate.length > 0
      ? BROKER_VOLUME_YESTERDAY_TRADERS
      : null,
    { yesterdayMidnight, isSystemAddressIn, chainIdIn: degradedChainsForGate },
    { schema: BrokerVolumeYesterdayTradersSchema },
  );
  const yesterdayPartialRows =
    venue === "v3"
      ? yesterdayV3Result.data?.volumeYesterdayTraders
      : yesterdayV2Result.data?.brokerVolumeYesterdayTraders;

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
    volumePartialOverlapTraders: VolumePartialOverlapRow[];
  }>(
    venue === "v3" && partialOverlapInput
      ? VOLUME_PARTIAL_OVERLAP_TRADERS
      : null,
    partialOverlapInput ?? { where: { _or: [] }, limit: 0 },
    { timeoutMs: 8_000, schema: VolumePartialOverlapTradersSchema },
  );
  const partialOverlapV2Result = useGQL<{
    brokerVolumePartialOverlapTraders: VolumePartialOverlapRow[];
  }>(
    venue === "v2" && partialOverlapInput
      ? BROKER_VOLUME_PARTIAL_OVERLAP_TRADERS
      : null,
    partialOverlapInput ?? { where: { _or: [] }, limit: 0 },
    { timeoutMs: 8_000, schema: BrokerVolumePartialOverlapTradersSchema },
  );
  const partialOverlapRows =
    partialOverlapInput === null
      ? []
      : partialOverlapInput === undefined
        ? undefined
        : venue === "v3"
          ? partialOverlapV3Result.data?.volumePartialOverlapTraders
          : partialOverlapV2Result.data?.brokerVolumePartialOverlapTraders;

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
  // `mergeHeroSnapshot` — see that helper's JSDoc in `lib/volume.ts`.
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
      ? heroV3Snapshot.isLoading || todayV3Result.isLoading
      : heroV2Snapshot.isLoading || todayV2Result.isLoading;
  const hasError =
    venue === "v3"
      ? !!heroV3Snapshot.error || !!todayV3Result.error
      : !!heroV2Snapshot.error || !!todayV2Result.error;

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

function preferPrimaryGqlResult<T>(
  primary: GqlState<T>,
  fallback: GqlState<T>,
): GqlState<T> {
  if (primary.data || primary.isLoading || !primary.error) return primary;
  return fallback;
}
