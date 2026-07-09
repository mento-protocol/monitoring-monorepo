"use client";

import { useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { useGQL } from "@/lib/graphql";
import { isLoadingWithoutData } from "@/lib/swr-state";
import {
  volumeHeroViewMatches,
  type VolumeHeroInitialData,
} from "@/lib/volume-hero-initial-data";
import {
  BROKER_VOLUME_PARTIAL_OVERLAP_TRADERS,
  BROKER_VOLUME_TODAY_TRADERS,
  BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST,
  BROKER_VOLUME_WINDOW_LATEST,
  BROKER_VOLUME_YESTERDAY_TRADERS,
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
 *     trader-query source comes from the parent (`kpiSource`) — this hook
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
  includeProtocolActors,
  isProtocolActorIn,
  utcDayKey,
  kpiSource,
  initialData,
}: {
  venue: Venue;
  range: VolumeRangeKey;
  includeProtocolActors: boolean;
  isProtocolActorIn: ReadonlyArray<boolean>;
  utcDayKey: number;
  /** Source list for top-10 concentration's numerator (paginated
   *  per-day query). The parent owns this query; the hook only consumes
   *  the resulting rows so the table query and the hero query can degrade
   *  independently. */
  kpiSource: ReadonlyArray<{ chainId: number; volumeUsdWei: bigint }>;
  /** Server-prefetched hero responses (perf-plan S4), forwarded to the
   *  matching `useGQL` calls as `fallbackData` so the first render paints
   *  populated tiles. Only attached when the prefetched view descriptor
   *  matches this render's actual (network, venue, range, actor filter,
   *  todayMidnight) — a mismatched fallback would seed the wrong SWR key. */
  initialData?: VolumeHeroInitialData | undefined;
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
  // Today's UTC midnight in seconds. The hero snapshot's upper bound is
  // yesterday, so today's TraderDailySnapshot rows fill in the gap.
  // Memoised on `utcDayKey` so it flips at midnight without retriggering
  // every minute.
  const todayMidnight = useMemo(
    () => Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY,
    [utcDayKey],
  );

  // View-parity gate for the SSR prefetch: only attach fallbackData when the
  // prefetched descriptor matches this render's key ingredients exactly (the
  // SWR key is [network.id, query, variables]). `networkId` is always
  // DEFAULT_NETWORK on /volume today, but comparing keeps a future network
  // switcher from seeding foreign-chain data. `todayMidnight` mismatches at
  // the UTC-midnight edge (server prefetched day N, client hydrates day N+1)
  // → no fallback, today's client-only loading path takes over. When both
  // sides are on day N but real time crossed midnight before the first poll,
  // the today-partial fallback is at most one day off for ≤30s (next poll
  // corrects it) — self-healing, acceptable.
  const { networkId } = useNetwork();
  const fallback =
    initialData &&
    volumeHeroViewMatches(initialData.view, {
      networkId,
      venue,
      range,
      isProtocolActorIn,
      todayMidnight,
    })
      ? initialData
      : undefined;

  // Pre-rolled hero snapshot (one row per chain for the active window).
  // Bypasses Hasura's 1000-row cap on long windows. The snapshot covers
  // [windowStart, yesterday]; today's partial is fetched separately and
  // added client-side.
  const heroV3Result = useGQL<HeroV3Data>(
    venue === "v3" ? VOLUME_WINDOW_LATEST : null,
    { windowKey: range },
    { schema: VolumeWindowLatestSchema, fallbackData: fallback?.heroV3 },
  );
  const heroV2Result = useGQL<HeroV2Data>(
    venue === "v2" ? BROKER_VOLUME_WINDOW_LATEST : null,
    { windowKey: range },
    { schema: BrokerVolumeWindowLatestSchema, fallbackData: fallback?.heroV2 },
  );

  const todayV3Result = useGQL<{
    volumeTodayTraders: VolumeTodayTraderRow[];
  }>(
    venue === "v3" ? VOLUME_TODAY_TRADERS : null,
    { todayMidnight, isProtocolActorIn },
    { schema: VolumeTodayTradersSchema, fallbackData: fallback?.todayV3 },
  );
  const todayV2Result = useGQL<{
    brokerVolumeTodayTraders: VolumeTodayTraderRow[];
  }>(
    venue === "v2" ? BROKER_VOLUME_TODAY_TRADERS : null,
    { todayMidnight, isProtocolActorIn },
    { schema: BrokerVolumeTodayTradersSchema, fallbackData: fallback?.todayV2 },
  );

  const snapshotRows =
    venue === "v3"
      ? heroV3Result.data?.volumeWindowSnapshots
      : heroV2Result.data?.brokerVolumeWindowSnapshots;
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
    {
      schema: VolumeWindowFirstDayLatestSchema,
      fallbackData: fallback?.firstDayV3,
    },
  );
  const heroFirstDayV2Result = useGQL<{
    brokerVolumeWindowFirstDaySnapshots: VolumeWindowFirstDayRow[];
  }>(
    venue === "v2" ? BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST : null,
    { windowKey: range },
    {
      schema: BrokerVolumeWindowFirstDayLatestSchema,
      fallbackData: fallback?.firstDayV2,
    },
  );
  const firstDayRows =
    venue === "v3"
      ? heroFirstDayV3Result.data?.volumeWindowFirstDaySnapshots
      : heroFirstDayV2Result.data?.brokerVolumeWindowFirstDaySnapshots;

  // First-pass merge — without `yesterdayRows`. Used solely to discover
  // which chains are in the DEGRADED state (snapshotDay = today - 2 days),
  // so we can gate the yesterday-traders query on them. Cheap (one
  // O(snapshotRows + todayRows) pass).
  const degradedChainsForGate = useMemo(
    () =>
      mergeHeroSnapshot({
        snapshotRows,
        todayRows: todayPartialRows,
        includeProtocolActors,
        todayMidnightSeconds: todayMidnight,
      }).degradedChains,
    [snapshotRows, todayPartialRows, includeProtocolActors, todayMidnight],
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
    { yesterdayMidnight, isProtocolActorIn, chainIdIn: degradedChainsForGate },
    { schema: VolumeYesterdayTradersSchema },
  );
  const yesterdayV2Result = useGQL<{
    brokerVolumeYesterdayTraders: VolumeTodayTraderRow[];
  }>(
    venue === "v2" && degradedChainsForGate.length > 0
      ? BROKER_VOLUME_YESTERDAY_TRADERS
      : null,
    { yesterdayMidnight, isProtocolActorIn, chainIdIn: degradedChainsForGate },
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
        includeProtocolActors,
        todayMidnightSeconds: todayMidnight,
        traderField: venue === "v2" ? "caller" : "trader",
      }),
    [
      snapshotRows,
      todayPartialRows,
      firstDayRows,
      yesterdayPartialRows,
      includeProtocolActors,
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
        includeProtocolActors,
        todayMidnightSeconds: todayMidnight,
      }),
    [
      snapshotRows,
      todayPartialRows,
      firstDayRows,
      yesterdayPartialRows,
      partialOverlapRows,
      includeProtocolActors,
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
  // land. The trader table loads independently from the existing
  // TraderDailySnapshot query (which is fast — capped at 1000 by design).
  // Gate on data presence, not bare `isLoading`: SWR does NOT count
  // `fallbackData` as "loaded data", so with the SSR prefetch attached
  // `isLoading` stays true through the first revalidation even though the
  // tiles already have real numbers to show (same rule as PoolOverview in
  // pool-detail-page-client.tsx).
  const isLoading =
    venue === "v3"
      ? isLoadingWithoutData(heroV3Result.isLoading, heroV3Result.data) ||
        isLoadingWithoutData(todayV3Result.isLoading, todayV3Result.data)
      : isLoadingWithoutData(heroV2Result.isLoading, heroV2Result.data) ||
        isLoadingWithoutData(todayV2Result.isLoading, todayV2Result.data);
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
