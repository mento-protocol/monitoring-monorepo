import { useId } from "react";
import { Tile } from "@/components/feedback";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import { VOLUME_RANGES, rangeDays, type VolumeRangeKey } from "@/lib/volume";
import {
  VOLUME_CHART_RANGES,
  VOLUME_FALLBACK_CHART_RANGES,
} from "@/lib/time-series";
import type { VolumePageModel, VolumeUrlState } from "../page-client";
import { TopPoolsList } from "./top-pools-list";
import { V2VolumeSection } from "./v2-volume-section";
import { V3VolumeSection } from "./v3-volume-section";

export function VolumePageHeader({ urlState }: { urlState: VolumeUrlState }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold text-white">
          Volume
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {volumeHeaderSubtitle(urlState)}
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
        {urlState.canUseVolumeFilters && (
          <ActorToggleGroup
            includeProtocolActors={urlState.includeProtocolActors}
            updateIncludeProtocolActors={urlState.updateIncludeProtocolActors}
          />
        )}
      </div>
    </header>
  );
}

function volumeHeaderSubtitle(urlState: VolumeUrlState): string {
  if (!urlState.canUseVolumeFilters) {
    return urlState.venue === "v3"
      ? "Top traders on Mento by total USD volume."
      : "Top legacy-v2 traders on Mento by total USD volume.";
  }
  return urlState.venue === "v3"
    ? "Top traders on Mento by USD volume. Protocol actors are excluded by default."
    : "Top legacy-v2 traders on Mento by USD volume. Protocol actors are excluded by default.";
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

function ActorToggleGroup({
  includeProtocolActors,
  updateIncludeProtocolActors,
}: {
  includeProtocolActors: boolean;
  updateIncludeProtocolActors: VolumeUrlState["updateIncludeProtocolActors"];
}) {
  return (
    <div
      role="group"
      aria-label="Protocol actors"
      className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
    >
      <SegmentButton
        active={!includeProtocolActors}
        label="Organic"
        tooltip="Organic shows external trader volume only. All also includes Mento protocol/internal flows."
        onClick={() => updateIncludeProtocolActors(false)}
      />
      <SegmentButton
        active={includeProtocolActors}
        label="All"
        onClick={() => updateIncludeProtocolActors(true)}
      />
    </div>
  );
}

function SegmentButton({
  active,
  label,
  tooltip,
  className = "",
  onClick,
}: {
  active: boolean;
  label: string;
  tooltip?: string;
  className?: string;
  onClick: () => void;
}) {
  const tooltipId = useId();
  const stateClass = active
    ? " bg-slate-700 text-white shadow-sm"
    : " text-slate-400 hover:text-slate-200";
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-pressed={active}
        aria-describedby={tooltip ? tooltipId : undefined}
        onClick={onClick}
        className={
          "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
          className +
          stateClass
        }
      >
        {label}
      </button>
      {tooltip && (
        <span
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none absolute right-0 top-full z-30 w-64 pt-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        >
          <span className="block rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-left text-xs font-normal leading-relaxed text-slate-200 shadow-lg">
            {tooltip}
          </span>
        </span>
      )}
    </span>
  );
}

export function VolumeKpiTiles({
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

export function VolumeChartArea({
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

export function VolumeVenueSection({
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
        canUseVolumeFilters={urlState.canUseVolumeFilters}
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
      protocolActorFilter={model.isProtocolActorIn}
      canUseVolumeFilters={urlState.canUseVolumeFilters}
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
