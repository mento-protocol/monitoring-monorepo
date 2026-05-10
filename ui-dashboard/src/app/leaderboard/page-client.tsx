"use client";

import { useCallback, useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { Tile } from "@/components/feedback";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import {
  BROKER_AGGREGATOR_DAILY_TOP,
  BROKER_TRADER_DAILY_TOP,
  POOL_DAILY_VOLUME,
  POOLS_FOR_LEADERBOARD,
  TRADER_DAILY_TOP,
} from "@/lib/queries/leaderboard";
import {
  LEADERBOARD_RANGES,
  aggregateBrokerAggregatorsByWindow,
  aggregateBrokerTradersByWindow,
  aggregateDailyVolume,
  aggregateTradersByWindow,
  rangeDays,
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type LeaderboardRangeKey,
  type TraderDailyRow,
} from "@/lib/leaderboard";
import type { PoolDailyVolumeRow } from "@/lib/leaderboard-pool";
import {
  LEADERBOARD_CHART_RANGES,
  LEADERBOARD_FALLBACK_CHART_RANGES,
  type RangeKey,
} from "@/lib/time-series";
import { HeroDataQualityBanners } from "./_components/hero-data-quality-banners";
import { LeaderboardTable } from "./_components/leaderboard-table";
import { TopPoolsList } from "./_components/top-pools-list";
import { V2LeaderboardSection } from "./_components/v2-leaderboard-section";
import { usePoolChartViewModel } from "./_lib/pool-chart-vm";
import { useHeroRollup } from "./_lib/use-hero-rollup";
import { useLeaderboardUrlState } from "./_lib/url-state";

type PoolRow = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
};

// Per-pool stacked chart needs ≥30 days of data to read meaningfully —
// hide it for shorter ranges (24h collapses to a point, 7d gives 7
// stacked bars of varying widths that look noisy).
const RANGES_WITH_CHART = new Set<LeaderboardRangeKey>(["30d", "90d", "all"]);

// Component is over the no-giant-component threshold — venue toggle
// + range filter + multi-table layout. Tracked in BACKLOG.md
// § "Architecture pass" for a focused split PR (extract
// LeaderboardFilters / V3Tables / V2Tables).
// react-doctor-disable-next-line react-doctor/no-giant-component
export function LeaderboardClient() {
  const {
    range,
    showSystem,
    venue,
    cutoff,
    utcDayKey,
    updateRange,
    updateShowSystem,
    updateVenue,
  } = useLeaderboardUrlState();

  const isSystemAddressIn = useMemo(
    () => (showSystem ? [false, true] : [false]),
    [showSystem],
  );

  // Each venue's queries are gated to its tab so we don't burn Envio quota
  // on the side the user isn't looking at — same trick as `expanded ? Q : null`
  // in LeaderboardTable.TraderRow.
  const tradersResult = useGQL<{ TraderDailySnapshot: TraderDailyRow[] }>(
    venue === "v3" ? TRADER_DAILY_TOP : null,
    {
      afterTimestamp: cutoff,
      isSystemAddressIn,
      limit: ENVIO_MAX_ROWS,
    },
  );
  const poolsResult = useGQL<{ Pool: PoolRow[] }>(
    venue === "v3" ? POOLS_FOR_LEADERBOARD : null,
    undefined,
    300_000, // pool metadata barely changes; refresh every 5 min
  );

  // Per-pool stacked chart data (v3-only). Separate query from
  // `TRADER_DAILY_TOP` because the chart needs (poolId, day) granularity
  // that the trader-day rollup throws away. Pre-rolling
  // `PoolDailyVolumeSnapshot` is the proper fix at scale (BACKLOG PR 4).
  // Skip the query entirely on v2 — broker-direct swaps don't carry
  // pool decomposition, so there's nothing to chart, and the query
  // would just churn an unused 1000-row response.
  const showChart = venue === "v3" && RANGES_WITH_CHART.has(range);
  const poolVolumeResult = useGQL<{
    TraderPoolDailySnapshot: PoolDailyVolumeRow[];
  }>(showChart ? POOL_DAILY_VOLUME : null, {
    afterTimestamp: cutoff,
    limit: ENVIO_MAX_ROWS,
  });

  const v2TradersResult = useGQL<{
    BrokerTraderDailySnapshot: BrokerTraderDailyRow[];
  }>(venue === "v2" ? BROKER_TRADER_DAILY_TOP : null, {
    afterTimestamp: cutoff,
    isSystemAddressIn,
    limit: ENVIO_MAX_ROWS,
  });
  const v2AggregatorsResult = useGQL<{
    BrokerAggregatorDailySnapshot: BrokerAggregatorDailyRow[];
  }>(venue === "v2" ? BROKER_AGGREGATOR_DAILY_TOP : null, {
    afterTimestamp: cutoff,
    limit: ENVIO_MAX_ROWS,
  });

  const traderRows = tradersResult.data?.TraderDailySnapshot ?? [];
  const poolRows = poolsResult.data?.Pool ?? [];
  const poolVolumeRows = poolVolumeResult.data?.TraderPoolDailySnapshot ?? [];
  const v2TraderRows = v2TradersResult.data?.BrokerTraderDailySnapshot ?? [];
  const v2AggregatorRows =
    v2AggregatorsResult.data?.BrokerAggregatorDailySnapshot ?? [];

  const aggregated = useMemo(
    () => aggregateTradersByWindow(traderRows),
    [traderRows],
  );
  const dailyVolume = useMemo(
    () => aggregateDailyVolume(traderRows),
    [traderRows],
  );
  const v2Aggregated = useMemo(
    () => aggregateBrokerTradersByWindow(v2TraderRows),
    [v2TraderRows],
  );
  const v2AggregatorAggregated = useMemo(
    () =>
      // Honour the page-level `Show system addresses` toggle on the
      // aggregator section too — `BrokerAggregatorDailySnapshot` uses
      // the canonical aggregator name, so the filter is on the
      // `"system"` bucket rather than an `isSystemAddress` flag. Filter
      // client-side because the schema doesn't carry an indexed
      // boolean for the aggregator side.
      aggregateBrokerAggregatorsByWindow(
        showSystem
          ? v2AggregatorRows
          : v2AggregatorRows.filter((r) => r.aggregator !== "system"),
      ),
    [v2AggregatorRows, showSystem],
  );
  const v2DailyVolume = useMemo(
    () => aggregateDailyVolume(v2TraderRows),
    [v2TraderRows],
  );

  // Lower-cased pool id keying so the table can look up
  // `${chainId}-${poolAddress}` regardless of how the indexer cased it.
  const poolMeta = useMemo(() => {
    const m = new Map<
      string,
      { token0: string | null; token1: string | null }
    >();
    for (const p of poolRows) {
      m.set(p.id.toLowerCase(), { token0: p.token0, token1: p.token1 });
    }
    return m;
  }, [poolRows]);

  // Per-pool stacked chart + Top Pools list view-model. Bundled in a
  // hook so the page client doesn't carry the full derivation chain
  // (allowlist → window → aggregation → chain decoration → list).
  // System-address toggle parity is preserved inside the hook —
  // TraderPoolDailySnapshot doesn't carry isSystemAddress, so the
  // hook day-scopes a `(chainId, trader, day)` allowlist against the
  // parent trader query's filtered rows.
  const { poolVolumeBreakdown, chartBreakdown, topPoolsListEntries } =
    usePoolChartViewModel({
      showSystem,
      traderRows,
      poolVolumeRows,
      poolMeta,
      cutoff,
      utcDayKey,
    });

  // Hero KPIs — totals come from the pre-rolled LeaderboardWindowSnapshot
  // plus today's partial (both exact, no Hasura row cap). Top-10
  // concentration uses the existing top-50 query for the numerator and
  // the snapshot total for the denominator: exact end-to-end.
  //
  // The hook owns the hero/today GraphQL queries, the `mergeHeroSnapshot`
  // call, and the top-10 ratio computation. The `kpiSource` numerator
  // still flows in from the active venue's table query so the hero
  // and table queries can degrade independently.
  const kpiSource = venue === "v3" ? aggregated : v2Aggregated;
  const hero = useHeroRollup({
    venue,
    range,
    showSystem,
    isSystemAddressIn,
    utcDayKey,
    kpiSource,
  });

  // Leaderboard ranges include `24h` (used by v3 single-line + v2
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

  // Page chrome / KPIs / chart / trader table all read from the
  // trader-side query for the active venue. The v2 aggregator query is
  // independent — its loading/error feed only the aggregator table below
  // so a slow or erroring `BrokerAggregatorDailySnapshot` (e.g. during the
  // post-deploy resync window for that new entity) doesn't take down the
  // trader view (the aggregator panel is the migration-outreach surface;
  // the trader table is a retention-metrics view). Codex review:
  // https://github.com/mento-protocol/monitoring-monorepo/pull/324#discussion_r3195117172
  const tableIsLoading =
    venue === "v3"
      ? tradersResult.isLoading || poolsResult.isLoading
      : v2TradersResult.isLoading;
  const tableHasError =
    venue === "v3" ? !!tradersResult.error : !!v2TradersResult.error;
  // Hero and table data are sourced from independent queries; a snapshot
  // failure must NOT blank the chart or top-50 table (and vice versa).
  // Per docs/pr-checklists/swr-polling-hasura.md: new schema fields ship
  // in isolated queries that degrade independently.
  const v2AggIsLoading = v2AggregatorsResult.isLoading;
  const v2AggHasError = !!v2AggregatorsResult.error;
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
  const isTableCapHit =
    venue === "v3"
      ? !!tradersResult.data &&
        (tradersResult.data.TraderDailySnapshot?.length ?? 0) === ENVIO_MAX_ROWS
      : !!v2TradersResult.data &&
        (v2TradersResult.data.BrokerTraderDailySnapshot?.length ?? 0) ===
          ENVIO_MAX_ROWS;
  // The per-pool POOL_DAILY_VOLUME query can also hit the 1000-row cap on
  // longer windows; smallest pool-days drop first, so the visual stack's
  // top-N stays intact. We don't surface a separate banner for it — the
  // pre-rolled PoolDailyVolumeSnapshot (BACKLOG.md PR 4) is the structural
  // fix and the cap rarely affects the readable signal at 7d/30d.
  //
  // BROKER_AGGREGATOR_DAILY_TOP is a top-N-volume cut. If it saturates
  // we'd silently drop long-tail aggregators from the table; surface it
  // with a separate banner above the aggregator section.
  const isV2AggregatorCapHit =
    venue === "v2" &&
    !!v2AggregatorsResult.data &&
    (v2AggregatorsResult.data.BrokerAggregatorDailySnapshot?.length ?? 0) ===
      ENVIO_MAX_ROWS;

  // Headline reads `totalVolume` from the hero snapshot, so it follows
  // hero loading/error — not the table's. Change pill is week-over-week
  // if the range is ≥7d, otherwise null (24h has no meaningful WoW peer).
  const headline =
    hero.isLoading || hero.hasError ? "" : formatUSD(hero.totalVolume);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-white">
            Volume Leaderboard
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {venue === "v3"
              ? "Top traders on Mento by USD volume — system addresses hidden by default."
              : "Top legacy-v2 traders on Mento by USD volume — system addresses hidden by default."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="Venue"
            className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
          >
            {(["v3", "v2"] as const).map((v) => {
              const active = venue === v;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateVenue(v)}
                  className={
                    "rounded px-3 py-1 text-xs font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
                    (active
                      ? "bg-slate-700 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200")
                  }
                >
                  {v}
                </button>
              );
            })}
          </div>
          <div
            role="group"
            aria-label="Time window"
            className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
          >
            {LEADERBOARD_RANGES.map((r) => {
              const active = range === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateRange(r.key)}
                  className={
                    "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
                    (active
                      ? "bg-slate-700 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200")
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => updateShowSystem(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-800 text-indigo-500 focus:ring-indigo-400"
            />
            Show system addresses
          </label>
        </div>
      </header>

      <HeroDataQualityBanners
        staleChains={hero.staleChains}
        degradedChains={hero.degradedChains}
        isLoading={hero.isLoading}
        hasError={hero.hasError}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile
          label="Total volume"
          value={
            hero.isLoading
              ? "…"
              : hero.hasError
                ? "—"
                : formatUSD(hero.totalVolume)
          }
          subtitle={rangeSubtitle(range)}
        />
        <Tile
          label="Unique traders"
          value={
            hero.isLoading
              ? "…"
              : hero.hasError
                ? "—"
                : hero.totalTraders.toLocaleString()
          }
          subtitle={`${hero.totalSwaps.toLocaleString()} swaps`}
        />
        <Tile
          label={
            isTableCapHit ? "Top-10 concentration (≈)" : "Top-10 concentration"
          }
          value={
            hero.isLoading || tableIsLoading
              ? "…"
              : hero.hasError || tableHasError
                ? "—"
                : `${isTableCapHit ? "≈ " : ""}${hero.concentration.toFixed(1)}%`
          }
          subtitle={
            isTableCapHit
              ? "Lower bound — long-tail trader-days outside top-1000 by single-day volume can bias this low"
              : "Share of window volume"
          }
        />
      </div>

      {/* Chart selection by (venue, range):
            - v3 + range≥30d: per-pool stacked chart (2/3) + Top Pools
              list (1/3). The list shows the leaderboard order across
              the whole window with a color swatch matching the chart
              stack. The chart needs ≥30d to have enough days for a
              readable stacked breakdown.
            - v3 + range<30d (24h, 7d): single-line daily-volume chart,
              full width. Same primary metric, just without the
              per-pool decomposition.
            - v2 + range≠24h: single-line daily v2 (broker-direct)
              volume chart, full width. v2 doesn't carry pool
              decomposition (broker swaps don't stamp poolId on the
              event), so per-pool stacking isn't possible.
            - v2 + 24h: chart suppressed (single-day collapse). */}
      {showChart ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="h-full lg:col-span-2">
            <TimeSeriesChartCard
              title="Volume by pool"
              rangeAriaLabel="Chart range"
              series={poolVolumeBreakdown.totalSeries}
              breakdown={chartBreakdown}
              breakdownMode="stacked"
              range={chartRange}
              onRangeChange={onChartRangeChange}
              ranges={LEADERBOARD_CHART_RANGES}
              headline={headline}
              change={null}
              isLoading={tableIsLoading || poolVolumeResult.isLoading}
              hasError={tableHasError || !!poolVolumeResult.error}
              hasSnapshotError={false}
              emptyMessage="No pool volume in this window."
              // Plot height tuned to roughly match the Top Pools list
              // tile's natural height — keeps the two tiles visually
              // balanced when sitting side-by-side. Minimal y-axis top
              // padding so peaks still reach close to the headline.
              chartHeightPx={250}
              yAxisTopPadding={0}
              // Sort hover-tooltip entries by the hovered day's volume
              // desc — Plotly's native unified hover uses fixed trace
              // order (rank by total window volume), which doesn't
              // match what's visually largest on a given day.
              customSortedHover
            />
          </div>
          <div className="h-full lg:col-span-1">
            <TopPoolsList
              entries={topPoolsListEntries}
              isLoading={tableIsLoading || poolVolumeResult.isLoading}
              hasError={tableHasError || !!poolVolumeResult.error}
              windowLabel={rangeLabel(range)}
            />
          </div>
        </div>
      ) : range !== "24h" ? (
        <TimeSeriesChartCard
          title={
            venue === "v3" ? "Daily traded volume" : "Daily v2 traded volume"
          }
          rangeAriaLabel="Chart range"
          series={venue === "v3" ? dailyVolume : v2DailyVolume}
          range={chartRange}
          onRangeChange={onChartRangeChange}
          ranges={LEADERBOARD_FALLBACK_CHART_RANGES}
          headline={headline}
          change={null}
          isLoading={tableIsLoading}
          hasError={tableHasError}
          hasSnapshotError={false}
          emptyMessage={
            venue === "v3"
              ? "No trader volume in this window."
              : "No legacy-v2 volume in this window."
          }
        />
      ) : null}

      {venue === "v3" ? (
        <section>
          <h2 className="mb-3 text-sm font-medium text-slate-300">
            Top traders ({rangeLabel(range)})
          </h2>
          <LeaderboardTable
            cutoff={cutoff}
            traders={aggregated}
            pools={poolMeta}
            isLoading={tableIsLoading}
            hasError={tableHasError}
          />
        </section>
      ) : (
        <V2LeaderboardSection
          rangeLabel={rangeLabel(range)}
          v2Aggregated={v2Aggregated}
          v2AggregatorAggregated={v2AggregatorAggregated}
          tableIsLoading={tableIsLoading}
          tableHasError={tableHasError}
          v2AggIsLoading={v2AggIsLoading}
          v2AggHasError={v2AggHasError}
          isV2AggregatorCapHit={isV2AggregatorCapHit}
        />
      )}
    </div>
  );
}

function rangeSubtitle(range: LeaderboardRangeKey): string {
  if (range === "all") return "All time";
  if (range === "24h") return "Today (UTC)";
  const days = rangeDays(range);
  return `Last ${days} days`;
}

function rangeLabel(range: LeaderboardRangeKey): string {
  if (range === "24h") return "24h";
  if (range === "7d") return "7d";
  if (range === "30d") return "1M";
  if (range === "90d") return "3M";
  return "all-time";
}
