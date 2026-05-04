"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { Tile } from "@/components/feedback";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import {
  POOLS_FOR_LEADERBOARD,
  TRADER_DAILY_TOP,
} from "@/lib/queries/leaderboard";
import {
  LEADERBOARD_RANGES,
  aggregateDailyVolume,
  aggregateTradersByWindow,
  rangeCutoffSeconds,
  rangeDays,
  weiToUsd,
  type LeaderboardRangeKey,
  type TraderDailyRow,
} from "@/lib/leaderboard";
import type { RangeKey } from "@/lib/time-series";
import { LeaderboardTable } from "./_components/leaderboard-table";

type PoolRow = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
};

const VALID_RANGES = new Set<LeaderboardRangeKey>(["24h", "7d", "30d", "all"]);

export function LeaderboardClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // URL-backed state for range + system-toggle so the view is shareable and
  // survives refresh — same pattern as bridge-flows page.
  const range = useMemo<LeaderboardRangeKey>(() => {
    const raw = searchParams.get("range");
    return raw && VALID_RANGES.has(raw as LeaderboardRangeKey)
      ? (raw as LeaderboardRangeKey)
      : "7d";
  }, [searchParams]);

  const showSystem = searchParams.get("system") === "1";

  const setRange = useCallback(
    (next: LeaderboardRangeKey) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "7d") params.delete("range");
      else params.set("range", next);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const setShowSystem = useCallback(
    (next: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("system", "1");
      else params.delete("system");
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const cutoff = rangeCutoffSeconds(range);
  const isSystemAddressIn = showSystem ? [false, true] : [false];

  const tradersResult = useGQL<{ TraderDailySnapshot: TraderDailyRow[] }>(
    TRADER_DAILY_TOP,
    {
      afterTimestamp: cutoff,
      isSystemAddressIn,
      limit: ENVIO_MAX_ROWS,
    },
  );
  const poolsResult = useGQL<{ Pool: PoolRow[] }>(
    POOLS_FOR_LEADERBOARD,
    undefined,
    300_000, // pool metadata barely changes; refresh every 5 min
  );

  const traderRows = tradersResult.data?.TraderDailySnapshot ?? [];
  const poolRows = poolsResult.data?.Pool ?? [];

  const aggregated = useMemo(
    () => aggregateTradersByWindow(traderRows),
    [traderRows],
  );
  const dailyVolume = useMemo(
    () => aggregateDailyVolume(traderRows),
    [traderRows],
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

  // Hero KPIs.
  const totalVolume = useMemo(() => {
    let acc = BigInt(0);
    for (const t of aggregated) acc += t.volumeUsdWei;
    return weiToUsd(acc);
  }, [aggregated]);

  const totalTraders = aggregated.length;
  const totalSwaps = useMemo(
    () => aggregated.reduce((acc, t) => acc + t.swapCount, 0),
    [aggregated],
  );
  const top10Concentration = useMemo(() => {
    if (aggregated.length === 0) return 0;
    let total = BigInt(0);
    let top10 = BigInt(0);
    for (let i = 0; i < aggregated.length; i += 1) {
      total += aggregated[i]!.volumeUsdWei;
      if (i < 10) top10 += aggregated[i]!.volumeUsdWei;
    }
    if (total === BigInt(0)) return 0;
    return Number((top10 * BigInt(10000)) / total) / 100;
  }, [aggregated]);

  // The TimeSeriesChartCard takes a 7d/30d/all RangeKey. Map the leaderboard
  // range onto the chart's range — both 24h and 7d show the 7d view (the
  // chart can't render a single-day point as a meaningful series anyway).
  const chartRange: RangeKey =
    range === "30d" ? "30d" : range === "all" ? "all" : "7d";
  const onChartRangeChange = useCallback(
    (next: RangeKey) => {
      setRange(next === "all" ? "all" : next === "30d" ? "30d" : "7d");
    },
    [setRange],
  );

  const isLoading = tradersResult.isLoading || poolsResult.isLoading;
  const hasError = !!tradersResult.error;

  // Headline = window total. Change pill is week-over-week if the range is
  // ≥7d, otherwise null (24h has no meaningful WoW peer).
  const headline = isLoading || hasError ? "" : formatUSD(totalVolume);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-white">
            Volume Leaderboard
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Top traders on Mento by USD volume — system addresses hidden by
            default.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
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
                  onClick={() => setRange(r.key)}
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
              onChange={(e) => setShowSystem(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-800 text-indigo-500 focus:ring-indigo-400"
            />
            Show system addresses
          </label>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile
          label="Total volume"
          value={isLoading ? "…" : formatUSD(totalVolume)}
          subtitle={rangeSubtitle(range)}
        />
        <Tile
          label="Unique traders"
          value={isLoading ? "…" : totalTraders.toLocaleString()}
          subtitle={`${totalSwaps.toLocaleString()} swaps`}
        />
        <Tile
          label="Top-10 concentration"
          value={isLoading ? "…" : `${top10Concentration.toFixed(1)}%`}
          subtitle="Share of window volume"
        />
      </div>

      <TimeSeriesChartCard
        title="Daily traded volume"
        rangeAriaLabel="Chart range"
        series={dailyVolume}
        range={chartRange}
        onRangeChange={onChartRangeChange}
        headline={headline}
        change={null}
        isLoading={isLoading}
        hasError={hasError}
        hasSnapshotError={false}
        emptyMessage="No trader volume in this window."
      />

      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-300">
          Top traders ({rangeLabel(range)})
        </h2>
        <LeaderboardTable
          range={range}
          traders={aggregated}
          pools={poolMeta}
          isLoading={isLoading}
          hasError={hasError}
        />
        {tradersResult.data &&
          (tradersResult.data.TraderDailySnapshot?.length ?? 0) ===
            ENVIO_MAX_ROWS && (
            <p className="mt-2 text-[11px] text-slate-500">
              Showing top {ENVIO_MAX_ROWS.toLocaleString()} trader-day rows by
              single-day volume in this window. Long-tail traders below this cap
              are omitted from the per-trader sums — top-of-list ranking is
              unaffected.
            </p>
          )}
      </section>
    </div>
  );
}

function rangeSubtitle(range: LeaderboardRangeKey): string {
  if (range === "all") return "All time";
  const days = rangeDays(range);
  if (days === 1) return "Last 24 hours";
  return `Last ${days} days`;
}

function rangeLabel(range: LeaderboardRangeKey): string {
  if (range === "24h") return "24h";
  if (range === "7d") return "7d";
  if (range === "30d") return "30d";
  return "all-time";
}
