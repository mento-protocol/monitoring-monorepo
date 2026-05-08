"use client";

import { useCallback, useMemo } from "react";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { Tile } from "@/components/feedback";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import {
  BROKER_AGGREGATOR_DAILY_TOP,
  BROKER_LEADERBOARD_TODAY_TRADERS,
  BROKER_LEADERBOARD_WINDOW_LATEST,
  BROKER_LEADERBOARD_YESTERDAY_TRADERS,
  BROKER_TRADER_DAILY_TOP,
  LEADERBOARD_TODAY_TRADERS,
  LEADERBOARD_WINDOW_LATEST,
  LEADERBOARD_YESTERDAY_TRADERS,
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
  mergeHeroSnapshot,
  rangeDays,
  top10Concentration,
  weiToUsd,
  type BrokerAggregatorDailyRow,
  type BrokerTraderDailyRow,
  type LeaderboardRangeKey,
  type LeaderboardTodayTraderRow,
  type LeaderboardWindowRow,
  type TraderDailyRow,
} from "@/lib/leaderboard";
import type { PoolDailyVolumeRow } from "@/lib/leaderboard-pool";
import {
  LEADERBOARD_CHART_RANGES,
  LEADERBOARD_FALLBACK_CHART_RANGES,
  SECONDS_PER_DAY,
  type RangeKey,
} from "@/lib/time-series";
import { HeroDataQualityBanners } from "./_components/hero-data-quality-banners";
import { LeaderboardTable } from "./_components/leaderboard-table";
import { TopPoolsList } from "./_components/top-pools-list";
import {
  V2LeaderboardAggregatorTable,
  V2LeaderboardTraderTable,
} from "./_components/v2-leaderboard-tables";
import { usePoolChartViewModel } from "./_lib/pool-chart-vm";
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

  // Pre-rolled hero snapshot (one row per chain for the active window).
  // Bypasses Hasura's 1000-row cap on long windows. The snapshot covers
  // [windowStart, yesterday]; today's partial is fetched separately and
  // added client-side.
  const heroV3Result = useGQL<{
    LeaderboardWindowSnapshot: LeaderboardWindowRow[];
  }>(venue === "v3" ? LEADERBOARD_WINDOW_LATEST : null, { windowKey: range });
  const heroV2Result = useGQL<{
    BrokerLeaderboardWindowSnapshot: LeaderboardWindowRow[];
  }>(venue === "v2" ? BROKER_LEADERBOARD_WINDOW_LATEST : null, {
    windowKey: range,
  });

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
  }>(venue === "v3" ? LEADERBOARD_TODAY_TRADERS : null, {
    todayMidnight,
    isSystemAddressIn,
  });
  const todayV2Result = useGQL<{
    BrokerTraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(venue === "v2" ? BROKER_LEADERBOARD_TODAY_TRADERS : null, {
    todayMidnight,
    isSystemAddressIn,
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
  const heroSnapshotRows =
    venue === "v3"
      ? heroV3Result.data?.LeaderboardWindowSnapshot
      : heroV2Result.data?.BrokerLeaderboardWindowSnapshot;
  const todayPartialRows =
    venue === "v3"
      ? todayV3Result.data?.TraderDailySnapshot
      : todayV2Result.data?.BrokerTraderDailySnapshot;

  // First-pass merge — without `yesterdayRows`. Used solely to
  // discover which chains are in the DEGRADED state (snapshotDay =
  // today - 2 days), so we can gate the yesterday-traders query on
  // them. Cheap (one O(snapshotRows + todayRows) pass).
  const degradedChainsForGate = useMemo(
    () =>
      mergeHeroSnapshot({
        snapshotRows: heroSnapshotRows,
        todayRows: todayPartialRows,
        showSystem,
        todayMidnightSeconds: todayMidnight,
      }).degradedChains,
    [heroSnapshotRows, todayPartialRows, showSystem, todayMidnight],
  );

  // Catch-up query for DEGRADED chains: fetches yesterday's
  // trader-day rows scoped to the degraded chainIds so the second
  // merge pass can perform slice subtraction (drop the snapshot's
  // first day, add yesterday + today). Gated on
  // `degradedChainsForGate.length > 0` via `useGQL`'s null-passthrough
  // convention so we don't burn Envio quota when no chain needs
  // catching up.
  const yesterdayMidnight = todayMidnight - SECONDS_PER_DAY;
  const yesterdayV3Result = useGQL<{
    TraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(
    venue === "v3" && degradedChainsForGate.length > 0
      ? LEADERBOARD_YESTERDAY_TRADERS
      : null,
    {
      yesterdayMidnight,
      isSystemAddressIn,
      chainIdIn: degradedChainsForGate,
    },
  );
  const yesterdayV2Result = useGQL<{
    BrokerTraderDailySnapshot: LeaderboardTodayTraderRow[];
  }>(
    venue === "v2" && degradedChainsForGate.length > 0
      ? BROKER_LEADERBOARD_YESTERDAY_TRADERS
      : null,
    {
      yesterdayMidnight,
      isSystemAddressIn,
      chainIdIn: degradedChainsForGate,
    },
  );
  const yesterdayPartialRows =
    venue === "v3"
      ? yesterdayV3Result.data?.TraderDailySnapshot
      : yesterdayV2Result.data?.BrokerTraderDailySnapshot;

  const heroTotals = useMemo(
    () =>
      mergeHeroSnapshot({
        snapshotRows: heroSnapshotRows,
        todayRows: todayPartialRows,
        yesterdayRows: yesterdayPartialRows,
        showSystem,
        todayMidnightSeconds: todayMidnight,
      }),
    [
      heroSnapshotRows,
      todayPartialRows,
      yesterdayPartialRows,
      showSystem,
      todayMidnight,
    ],
  );
  const totalVolume = useMemo(
    () => weiToUsd(heroTotals.totalVolumeUsdWei),
    [heroTotals.totalVolumeUsdWei],
  );
  const totalTraders = heroTotals.uniqueTraders;
  const totalSwaps = heroTotals.totalSwapCount;

  // Source list for top-10 concentration's numerator (top-50 paginated
  // per-day query). Denominator is the exact snapshot total above. The
  // helper applies the same stale-chain mask to numerator AND denominator
  // so the ratio stays coherent when a chain is silent — see
  // `top10Concentration` JSDoc in `lib/leaderboard.ts` for the rationale.
  const kpiSource = venue === "v3" ? aggregated : v2Aggregated;
  const concentration = useMemo(
    () =>
      top10Concentration({
        rowsByVolumeDesc: kpiSource,
        totalVolumeUsdWei: heroTotals.totalVolumeUsdWei,
        staleChains: heroTotals.staleChains,
      }),
    [kpiSource, heroTotals.totalVolumeUsdWei, heroTotals.staleChains],
  );

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

  // Page chrome / KPIs / chart / producer table all read from the
  // trader-side query for the active venue. The v2 aggregator query is
  // independent — its loading/error feed only the aggregator table below
  // so a slow or erroring `BrokerAggregatorDailySnapshot` (e.g. during the
  // post-deploy resync window for that new entity) doesn't take down the
  // producer view that's the actual outreach driver. Codex review:
  // https://github.com/mento-protocol/monitoring-monorepo/pull/324#discussion_r3195117172
  // Tiles + chart load when the hero snapshot AND its today-partial both
  // land. The top-50 table loads independently from the existing
  // TraderDailySnapshot query (which is fast — capped at 1000 by design).
  const heroIsLoading =
    venue === "v3"
      ? heroV3Result.isLoading || todayV3Result.isLoading
      : heroV2Result.isLoading || todayV2Result.isLoading;
  const heroHasError =
    venue === "v3"
      ? !!heroV3Result.error || !!todayV3Result.error
      : !!heroV2Result.error || !!todayV2Result.error;
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
  const headline = heroIsLoading || heroHasError ? "" : formatUSD(totalVolume);

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
              : "Top legacy-v2 producers — wallets and integrators we want to migrate to v3."}
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
        staleChains={heroTotals.staleChains}
        degradedChains={heroTotals.degradedChains}
        isLoading={heroIsLoading}
        hasError={heroHasError}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile
          label="Total volume"
          value={
            heroIsLoading ? "…" : heroHasError ? "—" : formatUSD(totalVolume)
          }
          subtitle={rangeSubtitle(range)}
        />
        <Tile
          label="Unique traders"
          value={
            heroIsLoading
              ? "…"
              : heroHasError
                ? "—"
                : totalTraders.toLocaleString()
          }
          subtitle={`${totalSwaps.toLocaleString()} swaps`}
        />
        <Tile
          label={
            isTableCapHit ? "Top-10 concentration (≈)" : "Top-10 concentration"
          }
          value={
            heroIsLoading || tableIsLoading
              ? "…"
              : heroHasError || tableHasError
                ? "—"
                : `${isTableCapHit ? "≈ " : ""}${concentration.toFixed(1)}%`
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
        <>
          <section>
            <h2 className="mb-3 text-sm font-medium text-slate-300">
              Top v2 producers ({rangeLabel(range)})
            </h2>
            <V2LeaderboardTraderTable
              traders={v2Aggregated}
              isLoading={tableIsLoading}
              hasError={tableHasError}
            />
          </section>
          <section>
            <h2 className="mb-3 text-sm font-medium text-slate-300">
              v2 volume by aggregator / entry-point ({rangeLabel(range)})
            </h2>
            <p className="mb-3 text-xs text-slate-500">
              Canonical name from <code>aggregators.json</code>. Large{" "}
              <span className="rounded bg-amber-900/40 px-1 py-px text-amber-200">
                unknown
              </span>{" "}
              rows are unclassified routers — file an entry to label them and
              reach out to the operator about migrating to v3.
            </p>
            {isV2AggregatorCapHit && (
              <div className="mb-3 rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90">
                <strong className="font-medium">
                  Approximate aggregator list.
                </strong>{" "}
                Showing the top {ENVIO_MAX_ROWS.toLocaleString()} aggregator-day
                rows by single-day volume — long-tail aggregators whose daily
                volume doesn&apos;t crack the cap may be missing.
              </div>
            )}
            <V2LeaderboardAggregatorTable
              aggregators={v2AggregatorAggregated}
              isLoading={v2AggIsLoading}
              hasError={v2AggHasError}
            />
          </section>
        </>
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
