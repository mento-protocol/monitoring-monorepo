"use client";

import { useCallback, useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { formatUSD } from "@/lib/format";
import {
  BROKER_TRADER_DAILY_TOP,
  POOLS_FOR_VOLUME,
  TRADER_DAILY_TOP,
  aggregatorDailyTopQuery,
  brokerAggregatorDailyTopQuery,
} from "@/lib/queries/volume";
import {
  AggregatorDailyTopSchema,
  BrokerAggregatorDailyTopSchema,
  BrokerTraderDailyTopSchema,
  PoolsForVolumeSchema,
  TraderDailyTopSchema,
} from "@/lib/queries/volume-schemas";
import {
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type VolumeRangeKey,
  type TraderDailyRow,
} from "@/lib/volume";
import {
  buildAggregatorDailyVolumeBreakdown,
  type AggregatorDailyRow,
  type AggregatorDailyRowBase,
} from "@/lib/volume-aggregators";
import { SECONDS_PER_DAY, type RangeKey } from "@/lib/time-series";
import { HeroDataQualityBanners } from "./_components/hero-data-quality-banners";
import {
  VolumeChartArea,
  VolumeKpiTiles,
  VolumePageHeader,
  VolumeVenueSection,
} from "./_components/volume-page-sections";
import { VolumeExclusionFilter } from "./_components/volume-exclusion-filter";
import { usePoolChartViewModel } from "./_lib/pool-chart-vm";
import { useHeroRollup } from "./_lib/use-hero-rollup";
import {
  useVolumeAggregates,
  volumeExclusionsForVenue,
} from "./_lib/use-volume-aggregates";
import { useVolumeUrlState } from "./_lib/url-state";
import { usePoolVolumeSnapshots } from "./_lib/use-pool-volume-snapshots";

type V3AggregatorsData = { AggregatorDailySnapshot: AggregatorDailyRow[] };

type PoolRow = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
};

// Per-pool stacked chart needs ≥30 days of data to read meaningfully —
// hide it for shorter ranges (24h collapses to a point, 7d gives 7
// stacked bars of varying widths that look noisy).
const RANGES_WITH_CHART = new Set<VolumeRangeKey>(["30d", "90d", "all"]);

export function VolumeClient() {
  const urlState = useVolumeUrlState();
  const model = useVolumePageModel(urlState);
  return <VolumePageView urlState={urlState} model={model} />;
}

export type VolumeUrlState = ReturnType<typeof useVolumeUrlState>;
export type VolumePageModel = ReturnType<typeof useVolumePageModel>;

function useVolumePageModel({
  range,
  includeProtocolActors,
  exclusions,
  venue,
  cutoff,
  utcDayKey,
  updateRange,
}: VolumeUrlState) {
  const isProtocolActorIn = useMemo(
    () => (includeProtocolActors ? [false, true] : [false]),
    [includeProtocolActors],
  );
  const showChart = venue === "v3" && RANGES_WITH_CHART.has(range);
  const queries = useVolumeQueries({
    venue,
    cutoff,
    includeProtocolActors,
    isProtocolActorIn,
    showChart,
  });
  const rows = readVolumeRows(queries);
  const effectiveExclusions = useMemo(
    () => volumeExclusionsForVenue(venue, exclusions),
    [venue, exclusions],
  );
  const aggregates = useVolumeAggregates({
    exclusions: effectiveExclusions,
    venue,
    includeProtocolActors,
    traderRows: rows.traderRows,
    v2TraderRows: rows.v2TraderRows,
    v3AggregatorRows: rows.v3AggregatorRows,
    v2AggregatorRows: rows.v2AggregatorRows,
  });
  const poolMeta = usePoolMeta(rows.poolRows);
  const poolChart = usePoolChartViewModel({
    includeProtocolActors: includeProtocolActors,
    poolVolumeRows: rows.poolVolumeRows,
    poolMeta,
    cutoff,
    utcDayKey,
  });
  const aggregatorChart = useV3AggregatorChart({
    cutoff,
    utcDayKey,
    rows: aggregates.filteredV3AggregatorRows,
  });
  const kpiSource =
    venue === "v3"
      ? aggregates.unfilteredAggregated
      : aggregates.unfilteredV2Aggregated;
  const hero = useHeroRollup({
    venue,
    range,
    includeProtocolActors: includeProtocolActors,
    isProtocolActorIn,
    utcDayKey,
    kpiSource,
  });
  const chartControls = useVolumeChartControls(range, updateRange);
  const status = buildVolumeStatus({ venue, queries });
  const headline =
    hero.isLoading || hero.hasError ? "" : formatUSD(hero.totalVolume);

  return {
    isProtocolActorIn,
    showChart,
    rows,
    aggregates,
    poolMeta,
    poolChart,
    aggregatorChart,
    hero,
    chartControls,
    status,
    headline,
  };
}

function useVolumeQueries({
  venue,
  cutoff,
  includeProtocolActors,
  isProtocolActorIn,
  showChart,
}: {
  venue: VolumeUrlState["venue"];
  cutoff: number;
  includeProtocolActors: boolean;
  isProtocolActorIn: ReadonlyArray<boolean>;
  showChart: boolean;
}) {
  // Each venue's queries are gated to its tab so we don't burn Envio quota
  // on the side the user isn't looking at — same trick as `expanded ? Q : null`
  // in VolumeTable.TraderRow.
  const tradersResult = useGQL<{ TraderDailySnapshot: TraderDailyRow[] }>(
    venue === "v3" ? TRADER_DAILY_TOP : null,
    {
      afterTimestamp: cutoff,
      isProtocolActorIn,
      limit: ENVIO_MAX_ROWS,
    },
    { timeoutMs: 8_000, schema: TraderDailyTopSchema },
  );
  const poolsResult = useGQL<{ Pool: PoolRow[] }>(
    venue === "v3" ? POOLS_FOR_VOLUME : null,
    undefined,
    300_000, // pool metadata barely changes; refresh every 5 min
    { timeoutMs: 8_000, schema: PoolsForVolumeSchema },
  );
  const poolVolumeResult = usePoolVolumeSnapshots({
    enabled: showChart,
    afterTimestamp: cutoff,
  });
  const v3AggregatorsResult = useGQL<V3AggregatorsData>(
    venue === "v3" ? aggregatorDailyTopQuery(includeProtocolActors) : null,
    { afterTimestamp: cutoff, limit: ENVIO_MAX_ROWS },
    { timeoutMs: 8_000, schema: AggregatorDailyTopSchema },
  );

  const v2TradersResult = useGQL<{
    BrokerTraderDailySnapshot: BrokerTraderDailyRow[];
  }>(
    venue === "v2" ? BROKER_TRADER_DAILY_TOP : null,
    { afterTimestamp: cutoff, isProtocolActorIn, limit: ENVIO_MAX_ROWS },
    { timeoutMs: 8_000, schema: BrokerTraderDailyTopSchema },
  );
  const v2AggregatorsResult = useGQL<{
    BrokerAggregatorDailySnapshot: BrokerAggregatorDailyRow[];
  }>(
    venue === "v2"
      ? brokerAggregatorDailyTopQuery(includeProtocolActors)
      : null,
    { afterTimestamp: cutoff, limit: ENVIO_MAX_ROWS },
    { timeoutMs: 8_000, schema: BrokerAggregatorDailyTopSchema },
  );
  return {
    tradersResult,
    poolsResult,
    poolVolumeResult,
    v3AggregatorsResult,
    v2TradersResult,
    v2AggregatorsResult,
  };
}

type VolumeQueries = ReturnType<typeof useVolumeQueries>;

function readVolumeRows({
  tradersResult,
  poolsResult,
  poolVolumeResult,
  v3AggregatorsResult,
  v2TradersResult,
  v2AggregatorsResult,
}: VolumeQueries) {
  const traderRows = tradersResult.data?.TraderDailySnapshot ?? [];
  const poolRows = poolsResult.data?.Pool ?? [];
  const poolVolumeRows = poolVolumeResult.rows;
  const v3AggregatorRows =
    v3AggregatorsResult.data?.AggregatorDailySnapshot ?? [];
  const v2TraderRows = v2TradersResult.data?.BrokerTraderDailySnapshot ?? [];
  const v2AggregatorRows =
    v2AggregatorsResult.data?.BrokerAggregatorDailySnapshot ?? [];
  return {
    traderRows,
    poolRows,
    poolVolumeRows,
    v3AggregatorRows,
    v2TraderRows,
    v2AggregatorRows,
  };
}

type VolumeRows = ReturnType<typeof readVolumeRows>;

function usePoolMeta(poolRows: VolumeRows["poolRows"]) {
  // Lower-cased pool id keying so the table can look up
  // `${chainId}-${poolAddress}` regardless of how the indexer cased it.
  return useMemo(() => {
    const m = new Map<
      string,
      { token0: string | null; token1: string | null }
    >();
    for (const p of poolRows) {
      m.set(p.id.toLowerCase(), { token0: p.token0, token1: p.token1 });
    }
    return m;
  }, [poolRows]);
}

function useV3AggregatorChart({
  cutoff,
  utcDayKey,
  rows,
}: {
  cutoff: number;
  utcDayKey: number;
  rows: readonly AggregatorDailyRowBase[];
}) {
  const aggregatorWindowRange = useMemo(() => {
    const todayMidnightUtc =
      Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    return cutoff > 0
      ? { fromSec: cutoff, toSec: todayMidnightUtc }
      : undefined;
  }, [cutoff, utcDayKey]);
  const v3AggregatorChart = useMemo(
    () => buildAggregatorDailyVolumeBreakdown(rows, aggregatorWindowRange),
    [rows, aggregatorWindowRange],
  );
  const v3AggregatorChartTotal = useMemo(
    () => v3AggregatorChart.totalSeries.reduce((sum, p) => sum + p.value, 0),
    [v3AggregatorChart],
  );
  return { v3AggregatorChart, v3AggregatorChartTotal };
}

function buildVolumeStatus({
  venue,
  queries,
}: {
  venue: VolumeUrlState["venue"];
  queries: VolumeQueries;
}) {
  const { poolVolumeResult, v3AggregatorsResult, v2AggregatorsResult } =
    queries;
  // Page chrome / KPIs / chart / trader table all read from the
  // trader-side query for the active venue. The v2 aggregator query is
  // independent — its loading/error feed only the aggregator table below
  // so a slow or erroring `BrokerAggregatorDailySnapshot` (e.g. during the
  // post-deploy resync window for that new entity) doesn't take down the
  // trader view (the aggregator panel is the migration-outreach surface;
  // the trader table is a retention-metrics view). Codex review:
  // https://github.com/mento-protocol/monitoring-monorepo/pull/324#discussion_r3195117172
  const tableIsLoading = volumeTableIsLoading({ venue, queries });
  const tableHasError = volumeTableHasError({ venue, queries });
  // Hero and table data are sourced from independent queries; a snapshot
  // failure must NOT blank the chart or top-50 table (and vice versa).
  // Per docs/pr-checklists/swr-polling-hasura.md: new schema fields ship
  // in isolated queries that degrade independently.
  const v2AggIsLoading = v2AggregatorsResult.isLoading;
  const v2AggHasError = !!v2AggregatorsResult.error;
  const v3AggIsLoading = v3AggregatorsResult.isLoading;
  const v3AggHasError = !!v3AggregatorsResult.error;
  // The pool chart now reads PoolDailyVolumeSnapshot, not the top-trader
  // query. Keep its degraded mode isolated so a capped/failing trader table
  // does not blank the pre-rolled pool breakdown.
  const poolChartIsLoading = poolVolumeResult.isLoading;
  const poolChartHasError =
    !!poolVolumeResult.error || poolVolumeResult.partial;
  // Independent Hasura cap signals.
  //
  // Hero tiles (total volume / unique traders / total swaps) are EXACT
  // regardless of any cap — they read the pre-rolled snapshot + today's
  // small partial, neither of which is cap-bound (PR #328).
  //
  // Top-10 concentration's NUMERATOR sums the top-50 table query's rows;
  // when that query caps, a top-10 trader whose long-tail single-day rows
  // fall outside the cap has an undercounted window-sum, biasing the
  // concentration ratio low. Badge that one tile with `(≈)`.
  const isTableCapHit = volumeTableCapHit({ venue, queries });
  // BROKER_AGGREGATOR_DAILY_TOP is a top-N-volume cut. If it saturates
  // we'd silently drop long-tail aggregators from the table; surface it
  // with a separate banner above the aggregator section.
  const isV2AggregatorCapHit = v2AggregatorCapHit({ venue, queries });
  const isV3AggregatorCapHit = v3AggregatorCapHit({ venue, queries });
  return {
    tableIsLoading,
    tableHasError,
    v2AggIsLoading,
    v2AggHasError,
    v3AggIsLoading,
    v3AggHasError,
    poolChartIsLoading,
    poolChartHasError,
    isTableCapHit,
    isV2AggregatorCapHit,
    isV3AggregatorCapHit,
  };
}

function volumeTableIsLoading({
  venue,
  queries,
}: {
  venue: VolumeUrlState["venue"];
  queries: VolumeQueries;
}): boolean {
  return venue === "v3"
    ? queries.tradersResult.isLoading || queries.poolsResult.isLoading
    : queries.v2TradersResult.isLoading;
}

function volumeTableHasError({
  venue,
  queries,
}: {
  venue: VolumeUrlState["venue"];
  queries: VolumeQueries;
}): boolean {
  return venue === "v3"
    ? !!queries.tradersResult.error
    : !!queries.v2TradersResult.error;
}

function volumeTableCapHit({
  venue,
  queries,
}: {
  venue: VolumeUrlState["venue"];
  queries: VolumeQueries;
}): boolean {
  if (venue === "v3") {
    return (
      !!queries.tradersResult.data &&
      (queries.tradersResult.data.TraderDailySnapshot?.length ?? 0) ===
        ENVIO_MAX_ROWS
    );
  }
  return (
    !!queries.v2TradersResult.data &&
    (queries.v2TradersResult.data.BrokerTraderDailySnapshot?.length ?? 0) ===
      ENVIO_MAX_ROWS
  );
}

function v2AggregatorCapHit({
  venue,
  queries,
}: {
  venue: VolumeUrlState["venue"];
  queries: VolumeQueries;
}): boolean {
  return (
    venue === "v2" &&
    !!queries.v2AggregatorsResult.data &&
    (queries.v2AggregatorsResult.data.BrokerAggregatorDailySnapshot?.length ??
      0) === ENVIO_MAX_ROWS
  );
}

function v3AggregatorCapHit({
  venue,
  queries,
}: {
  venue: VolumeUrlState["venue"];
  queries: VolumeQueries;
}): boolean {
  return (
    venue === "v3" &&
    !!queries.v3AggregatorsResult.data &&
    (queries.v3AggregatorsResult.data.AggregatorDailySnapshot?.length ?? 0) ===
      ENVIO_MAX_ROWS
  );
}

function VolumePageView({
  urlState,
  model,
}: {
  urlState: VolumeUrlState;
  model: VolumePageModel;
}) {
  const { hero, status, aggregates } = model;
  const displayedExclusions = volumeExclusionsForVenue(
    urlState.venue,
    urlState.exclusions,
  );
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <VolumePageHeader urlState={urlState} />
      <VolumeExclusionFilter
        exclusions={displayedExclusions}
        allowSourceExclusions={urlState.venue === "v3"}
        sourceOptions={aggregates.sourceOptions}
        onChange={urlState.updateExclusions}
      />
      <HeroDataQualityBanners
        staleChains={hero.staleChains}
        degradedChains={hero.degradedChains}
        isLoading={hero.isLoading}
        hasError={hero.hasError}
      />
      <VolumeChartArea urlState={urlState} model={model} />
      <VolumeKpiTiles
        hero={hero}
        range={urlState.range}
        isTableCapHit={status.isTableCapHit}
        tableIsLoading={status.tableIsLoading}
        tableHasError={status.tableHasError}
      />
      <VolumeVenueSection urlState={urlState} model={model} />
    </div>
  );
}

function useVolumeChartControls(
  range: VolumeRangeKey,
  updateRange: (next: VolumeRangeKey) => void,
): {
  chartRange: RangeKey;
  onChartRangeChange: (next: RangeKey) => void;
} {
  // Volume ranges include `24h` (used by v3 single-line + v2
  // single-line charts via `range !== "24h"` gate elsewhere) and `7d`,
  // neither of which exists in the global `RangeKey`. When the active
  // range falls outside the chart's accepted set, coerce to "7d" — the
  // chart isn't actually rendered for those ranges (24h gets the
  // `range !== "24h"` short-circuit in JSX), so the value is only used
  // to populate the chart's range-pill highlight if it ever does
  // render.
  const chartRange: RangeKey =
    range === "30d" || range === "90d" || range === "all" ? range : "7d";
  const onChartRangeChange = useCallback(
    (next: RangeKey) => {
      if (next === "7d" || next === "30d" || next === "90d" || next === "all") {
        updateRange(next);
      }
    },
    [updateRange],
  );
  return { chartRange, onChartRangeChange };
}
