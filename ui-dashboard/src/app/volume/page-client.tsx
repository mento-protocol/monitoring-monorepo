"use client";

import { useCallback, useMemo } from "react";
import { clusterNames } from "@mento-protocol/monitoring-config/aggregators";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { Tile } from "@/components/feedback";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import {
  BROKER_AGGREGATOR_DAILY_TOP,
  BROKER_TRADER_DAILY_TOP,
  POOLS_FOR_VOLUME,
  TRADER_DAILY_TOP,
  aggregatorDailyTopQuery,
} from "@/lib/queries/volume";
import {
  AggregatorDailyTopSchema,
  BrokerAggregatorDailyTopSchema,
  BrokerTraderDailyTopSchema,
  PoolsForVolumeSchema,
  TraderDailyTopSchema,
} from "@/lib/queries/volume-schemas";
import {
  VOLUME_RANGES,
  aggregateBrokerTradersByWindow,
  aggregateDailyVolume,
  aggregateTradersByWindow,
  rangeDays,
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type VolumeRangeKey,
  type TraderDailyRow,
} from "@/lib/volume";
import {
  aggregateAggregatorsByWindow,
  buildAggregatorDailyVolumeBreakdown,
  selectAggregatorRowsForSystemToggle,
  type AggregatorDailyRow,
  type AggregatorDailyRowBase,
} from "@/lib/volume-aggregators";
import {
  filterAggregatorRowsByVolumeExclusions,
  filterBrokerTraderRowsByVolumeExclusions,
  filterTraderRowsByVolumeExclusions,
  hasVolumeExclusions,
} from "@/lib/volume-exclusions";
import {
  VOLUME_CHART_RANGES,
  VOLUME_FALLBACK_CHART_RANGES,
  SECONDS_PER_DAY,
  type RangeKey,
} from "@/lib/time-series";
import { HeroDataQualityBanners } from "./_components/hero-data-quality-banners";
import { TopPoolsList } from "./_components/top-pools-list";
import { V2VolumeSection } from "./_components/v2-volume-section";
import { V3VolumeSection } from "./_components/v3-volume-section";
import { VolumeExclusionFilter } from "./_components/volume-exclusion-filter";
import { usePoolChartViewModel } from "./_lib/pool-chart-vm";
import { useHeroRollup } from "./_lib/use-hero-rollup";
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
const CLUSTER_SOURCE_OPTIONS = clusterNames();

export function VolumeClient() {
  const urlState = useVolumeUrlState();
  const model = useVolumePageModel(urlState);
  return <VolumePageView urlState={urlState} model={model} />;
}

type VolumeUrlState = ReturnType<typeof useVolumeUrlState>;
type VolumePageModel = ReturnType<typeof useVolumePageModel>;

function useVolumePageModel({
  range,
  includeProtocolActors,
  exclusions,
  venue,
  cutoff,
  utcDayKey,
  updateRange,
}: VolumeUrlState) {
  const isSystemAddressIn = useMemo(
    () => (includeProtocolActors ? [false, true] : [false]),
    [includeProtocolActors],
  );
  const showChart = venue === "v3" && RANGES_WITH_CHART.has(range);
  const queries = useVolumeQueries({
    venue,
    cutoff,
    includeProtocolActors,
    isSystemAddressIn,
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
    showSystem: includeProtocolActors,
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
    showSystem: includeProtocolActors,
    isSystemAddressIn,
    utcDayKey,
    kpiSource,
  });
  const chartControls = useVolumeChartControls(range, updateRange);
  const status = buildVolumeStatus({ venue, queries });
  const headline =
    hero.isLoading || hero.hasError ? "" : formatUSD(hero.totalVolume);

  return {
    isSystemAddressIn,
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
  isSystemAddressIn,
  showChart,
}: {
  venue: VolumeUrlState["venue"];
  cutoff: number;
  includeProtocolActors: boolean;
  isSystemAddressIn: ReadonlyArray<boolean>;
  showChart: boolean;
}) {
  // Each venue's queries are gated to its tab so we don't burn Envio quota
  // on the side the user isn't looking at — same trick as `expanded ? Q : null`
  // in VolumeTable.TraderRow.
  const tradersResult = useGQL<{ TraderDailySnapshot: TraderDailyRow[] }>(
    venue === "v3" ? TRADER_DAILY_TOP : null,
    {
      afterTimestamp: cutoff,
      isSystemAddressIn,
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
    { afterTimestamp: cutoff, isSystemAddressIn, limit: ENVIO_MAX_ROWS },
    { timeoutMs: 8_000, schema: BrokerTraderDailyTopSchema },
  );
  const v2AggregatorsResult = useGQL<{
    BrokerAggregatorDailySnapshot: BrokerAggregatorDailyRow[];
  }>(
    venue === "v2" ? BROKER_AGGREGATOR_DAILY_TOP : null,
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

function useVolumeAggregates({
  exclusions,
  venue,
  includeProtocolActors,
  traderRows,
  v2TraderRows,
  v3AggregatorRows,
  v2AggregatorRows,
}: {
  exclusions: VolumeUrlState["exclusions"];
  venue: VolumeUrlState["venue"];
  includeProtocolActors: boolean;
  traderRows: VolumeRows["traderRows"];
  v2TraderRows: VolumeRows["v2TraderRows"];
  v3AggregatorRows: VolumeRows["v3AggregatorRows"];
  v2AggregatorRows: VolumeRows["v2AggregatorRows"];
}) {
  const exclusionModel = useVolumeExclusionModel({
    exclusions,
    venue,
    includeProtocolActors,
    traderRows,
    v2TraderRows,
    v3AggregatorRows,
    v2AggregatorRows,
  });
  const {
    hasExploratoryExclusions,
    filteredTraderRows,
    filteredV2TraderRows,
    filteredV3AggregatorRows,
    filteredV2AggregatorRows,
    sourceOptions,
  } = exclusionModel;

  const aggregated = useMemo(
    () => aggregateTradersByWindow(filteredTraderRows),
    [filteredTraderRows],
  );
  const dailyVolume = useMemo(
    () => aggregateDailyVolume(filteredTraderRows),
    [filteredTraderRows],
  );
  const unfilteredAggregated = useMemo(
    () => aggregateTradersByWindow(traderRows),
    [traderRows],
  );
  const v2Aggregated = useMemo(
    () => aggregateBrokerTradersByWindow(filteredV2TraderRows),
    [filteredV2TraderRows],
  );
  const unfilteredV2Aggregated = useMemo(
    () => aggregateBrokerTradersByWindow(v2TraderRows),
    [v2TraderRows],
  );
  const v3AggregatorAggregated = useMemo(
    () => aggregateAggregatorsByWindow(filteredV3AggregatorRows),
    [filteredV3AggregatorRows],
  );
  const v2AggregatorAggregated = useMemo(
    () => aggregateAggregatorsByWindow(filteredV2AggregatorRows),
    [filteredV2AggregatorRows],
  );
  const v2DailyVolume = useMemo(
    () => aggregateDailyVolume(filteredV2TraderRows),
    [filteredV2TraderRows],
  );
  return {
    hasExploratoryExclusions,
    filteredTraderRows,
    filteredV2TraderRows,
    filteredV3AggregatorRows,
    filteredV2AggregatorRows,
    sourceOptions,
    aggregated,
    dailyVolume,
    unfilteredAggregated,
    v2Aggregated,
    unfilteredV2Aggregated,
    v3AggregatorAggregated,
    v2AggregatorAggregated,
    v2DailyVolume,
  };
}

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

function VolumePageHeader({ urlState }: { urlState: VolumeUrlState }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold text-white">
          Volume
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {urlState.venue === "v3"
            ? "Top traders on Mento by USD volume. Protocol actors are excluded by default."
            : "Top legacy-v2 traders on Mento by USD volume. Protocol actors are excluded by default."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <VenueToggleGroup
          venue={urlState.venue}
          updateVenue={urlState.updateVenue}
        />
        <RangeToggleGroup
          range={urlState.range}
          updateRange={urlState.updateRange}
        />
        <label className="inline-flex items-center gap-2 text-xs text-slate-400 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={urlState.includeProtocolActors}
            onChange={(event) =>
              urlState.updateIncludeProtocolActors(event.target.checked)
            }
            className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-800 text-indigo-500 focus:ring-indigo-400"
          />
          Include protocol actors
        </label>
      </div>
    </header>
  );
}

function VenueToggleGroup({
  venue,
  updateVenue,
}: {
  venue: VolumeUrlState["venue"];
  updateVenue: VolumeUrlState["updateVenue"];
}) {
  return (
    <div
      role="group"
      aria-label="Venue"
      className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
    >
      {(["v3", "v2"] as const).map((v) => (
        <SegmentButton
          key={v}
          active={venue === v}
          label={v}
          className="uppercase tracking-wide"
          onClick={() => updateVenue(v)}
        />
      ))}
    </div>
  );
}

function RangeToggleGroup({
  range,
  updateRange,
}: {
  range: VolumeRangeKey;
  updateRange: VolumeUrlState["updateRange"];
}) {
  return (
    <div
      role="group"
      aria-label="Time window"
      className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
    >
      {VOLUME_RANGES.map((r) => (
        <SegmentButton
          key={r.key}
          active={range === r.key}
          label={r.label}
          onClick={() => updateRange(r.key)}
        />
      ))}
    </div>
  );
}

function SegmentButton({
  active,
  label,
  className = "",
  onClick,
}: {
  active: boolean;
  label: string;
  className?: string;
  onClick: () => void;
}) {
  const stateClass = active
    ? " bg-slate-700 text-white shadow-sm"
    : " text-slate-400 hover:text-slate-200";
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
        className +
        stateClass
      }
    >
      {label}
    </button>
  );
}

function VolumeKpiTiles({
  hero,
  range,
  isTableCapHit,
  tableIsLoading,
  tableHasError,
}: {
  hero: VolumePageModel["hero"];
  range: VolumeRangeKey;
  isTableCapHit: boolean;
  tableIsLoading: boolean;
  tableHasError: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Tile
        label="Total volume"
        value={heroValue(hero, formatUSD(hero.totalVolume))}
        subtitle={rangeSubtitle(range)}
      />
      <Tile
        label="Unique traders"
        value={heroValue(hero, hero.totalTraders.toLocaleString())}
        subtitle={`${hero.totalSwaps.toLocaleString()} swaps`}
      />
      <Tile
        label={
          isTableCapHit ? "Top-10 concentration (≈)" : "Top-10 concentration"
        }
        value={concentrationValue({
          hero,
          isTableCapHit,
          tableIsLoading,
          tableHasError,
        })}
        subtitle={
          isTableCapHit
            ? "Lower bound — long-tail trader-days outside top-1000 by single-day volume can bias this low"
            : "Share of window volume"
        }
      />
    </div>
  );
}

function heroValue(hero: VolumePageModel["hero"], value: string): string {
  if (hero.isLoading) return "…";
  if (hero.hasError) return "—";
  return value;
}

function concentrationValue({
  hero,
  isTableCapHit,
  tableIsLoading,
  tableHasError,
}: {
  hero: VolumePageModel["hero"];
  isTableCapHit: boolean;
  tableIsLoading: boolean;
  tableHasError: boolean;
}): string {
  if (hero.isLoading || tableIsLoading) return "…";
  if (hero.hasError || tableHasError) return "—";
  return `${isTableCapHit ? "≈ " : ""}${hero.concentration.toFixed(1)}%`;
}

function VolumeChartArea({
  urlState,
  model,
}: {
  urlState: VolumeUrlState;
  model: VolumePageModel;
}) {
  if (model.showChart)
    return <PoolChartArea urlState={urlState} model={model} />;
  if (urlState.range === "24h") return null;
  return <DailyVolumeChart urlState={urlState} model={model} />;
}

function PoolChartArea({
  urlState,
  model,
}: {
  urlState: VolumeUrlState;
  model: VolumePageModel;
}) {
  const { poolVolumeBreakdown, chartBreakdown, topPoolsListEntries } =
    model.poolChart;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="h-full lg:col-span-2">
        <TimeSeriesChartCard
          title="Volume by pool"
          rangeAriaLabel="Chart range"
          series={poolVolumeBreakdown.totalSeries}
          breakdown={chartBreakdown}
          breakdownMode="stacked"
          range={model.chartControls.chartRange}
          onRangeChange={model.chartControls.onChartRangeChange}
          ranges={VOLUME_CHART_RANGES}
          headline={model.headline}
          change={null}
          isLoading={model.status.poolChartIsLoading}
          hasError={model.status.poolChartHasError}
          hasSnapshotError={false}
          emptyMessage="No pool volume in this window."
          chartHeightPx={250}
          yAxisTopPadding={0}
          customSortedHover
        />
      </div>
      <div className="h-full lg:col-span-1">
        <TopPoolsList
          entries={topPoolsListEntries}
          isLoading={model.status.poolChartIsLoading}
          hasError={model.status.poolChartHasError}
          windowLabel={rangeLabel(urlState.range)}
        />
      </div>
    </div>
  );
}

function DailyVolumeChart({
  urlState,
  model,
}: {
  urlState: VolumeUrlState;
  model: VolumePageModel;
}) {
  const { venue } = urlState;
  const { aggregates, chartControls, status } = model;
  return (
    <TimeSeriesChartCard
      title={venue === "v3" ? "Daily traded volume" : "Daily v2 traded volume"}
      rangeAriaLabel="Chart range"
      series={
        venue === "v3" ? aggregates.dailyVolume : aggregates.v2DailyVolume
      }
      range={chartControls.chartRange}
      onRangeChange={chartControls.onChartRangeChange}
      ranges={VOLUME_FALLBACK_CHART_RANGES}
      headline={model.headline}
      change={null}
      isLoading={status.tableIsLoading}
      hasError={status.tableHasError}
      hasSnapshotError={false}
      emptyMessage={
        venue === "v3"
          ? "No trader volume in this window."
          : "No legacy-v2 volume in this window."
      }
    />
  );
}

function VolumeVenueSection({
  urlState,
  model,
}: {
  urlState: VolumeUrlState;
  model: VolumePageModel;
}) {
  const { range, cutoff, exclusions } = urlState;
  const { aggregates, status } = model;
  if (urlState.venue === "v2") {
    return (
      <V2VolumeSection
        rangeLabel={rangeLabel(range)}
        cutoff={cutoff}
        v2Aggregated={aggregates.v2Aggregated}
        v2AggregatorAggregated={aggregates.v2AggregatorAggregated}
        hasExploratoryExclusions={aggregates.hasExploratoryExclusions}
        tableIsLoading={status.tableIsLoading}
        tableHasError={status.tableHasError}
        v2AggIsLoading={status.v2AggIsLoading}
        v2AggHasError={status.v2AggHasError}
        isV2AggregatorCapHit={status.isV2AggregatorCapHit}
      />
    );
  }
  return (
    <V3VolumeSection
      rangeLabel={rangeLabel(range)}
      range={range}
      cutoff={cutoff}
      filteredTraderRows={aggregates.filteredTraderRows}
      traders={aggregates.aggregated}
      pools={model.poolMeta}
      systemAddressFilter={model.isSystemAddressIn}
      exclusions={exclusions}
      tableState={{
        isLoading: status.tableIsLoading,
        hasError: status.tableHasError,
        isCapHit: status.isTableCapHit,
        hasExploratoryExclusions: aggregates.hasExploratoryExclusions,
      }}
      aggregators={aggregates.v3AggregatorAggregated}
      aggregatorState={{
        isLoading: status.v3AggIsLoading,
        hasError: status.v3AggHasError,
        isCapHit: status.isV3AggregatorCapHit,
      }}
      chart={v3SourceChart(urlState, model)}
    />
  );
}

function v3SourceChart(urlState: VolumeUrlState, model: VolumePageModel) {
  if (urlState.range === "24h") return undefined;
  return {
    series: model.aggregatorChart.v3AggregatorChart.totalSeries,
    breakdown: model.aggregatorChart.v3AggregatorChart.breakdown,
    range: model.chartControls.chartRange,
    onRangeChange: model.chartControls.onChartRangeChange,
    ranges: VOLUME_FALLBACK_CHART_RANGES,
    headline: formatUSD(model.aggregatorChart.v3AggregatorChartTotal),
  };
}

function useVolumeExclusionModel({
  exclusions,
  venue,
  includeProtocolActors,
  traderRows,
  v2TraderRows,
  v3AggregatorRows,
  v2AggregatorRows,
}: {
  exclusions: ReturnType<typeof useVolumeUrlState>["exclusions"];
  venue: ReturnType<typeof useVolumeUrlState>["venue"];
  includeProtocolActors: boolean;
  traderRows: readonly TraderDailyRow[];
  v2TraderRows: readonly BrokerTraderDailyRow[];
  v3AggregatorRows: readonly AggregatorDailyRow[];
  v2AggregatorRows: readonly BrokerAggregatorDailyRow[];
}) {
  const hasExploratoryExclusions = hasVolumeExclusions(exclusions);
  const filteredTraderRows = useMemo(
    () => filterTraderRowsByVolumeExclusions(traderRows, exclusions),
    [traderRows, exclusions],
  );
  const filteredV2TraderRows = useMemo(
    () => filterBrokerTraderRowsByVolumeExclusions(v2TraderRows, exclusions),
    [v2TraderRows, exclusions],
  );
  const selectedV3AggregatorRows = useMemo(
    () =>
      selectAggregatorRowsForSystemToggle(
        v3AggregatorRows,
        includeProtocolActors,
      ),
    [v3AggregatorRows, includeProtocolActors],
  );
  const filteredV3AggregatorRows = useMemo(
    () =>
      filterAggregatorRowsByVolumeExclusions(
        selectedV3AggregatorRows,
        exclusions,
      ),
    [selectedV3AggregatorRows, exclusions],
  );
  const selectedV2AggregatorRows = useMemo(
    () =>
      includeProtocolActors
        ? v2AggregatorRows
        : v2AggregatorRows.filter((r) => r.aggregator !== "system"),
    [v2AggregatorRows, includeProtocolActors],
  );
  const filteredV2AggregatorRows = useMemo(
    () =>
      filterAggregatorRowsByVolumeExclusions(
        selectedV2AggregatorRows,
        exclusions,
      ),
    [selectedV2AggregatorRows, exclusions],
  );
  const sourceOptions = useMemo(
    () =>
      venue === "v3"
        ? buildSourceOptions({
            traderRows,
            v3AggregatorRows,
          })
        : [],
    [venue, traderRows, v3AggregatorRows],
  );
  return {
    hasExploratoryExclusions,
    filteredTraderRows,
    filteredV2TraderRows,
    filteredV3AggregatorRows,
    filteredV2AggregatorRows,
    sourceOptions,
  };
}

function volumeExclusionsForVenue(
  venue: VolumeUrlState["venue"],
  exclusions: VolumeUrlState["exclusions"],
): VolumeUrlState["exclusions"] {
  if (venue === "v3" || exclusions.sources.length === 0) return exclusions;
  return { addresses: exclusions.addresses, sources: [] };
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

function rangeSubtitle(range: VolumeRangeKey): string {
  if (range === "all") return "All time";
  if (range === "24h") return "Today (UTC)";
  const days = rangeDays(range);
  return `Last ${days} days`;
}

function rangeLabel(range: VolumeRangeKey): string {
  if (range === "24h") return "24h";
  if (range === "7d") return "7d";
  if (range === "30d") return "1M";
  if (range === "90d") return "3M";
  return "all-time";
}

function buildSourceOptions({
  traderRows,
  v3AggregatorRows,
}: {
  traderRows: readonly TraderDailyRow[];
  v3AggregatorRows: readonly AggregatorDailyRow[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of CLUSTER_SOURCE_OPTIONS) appendSource(out, seen, source);
  for (const row of traderRows) {
    for (const source of row.aggregatorKeys ?? []) {
      appendSource(out, seen, source);
    }
  }
  for (const row of v3AggregatorRows) appendSource(out, seen, row.aggregator);
  return out;
}

function appendSource(out: string[], seen: Set<string>, source: string): void {
  const normalized = source.toLowerCase();
  if (seen.has(normalized)) return;
  seen.add(normalized);
  out.push(normalized);
}
