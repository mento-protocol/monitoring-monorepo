"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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

function readRangeFromParams(params: URLSearchParams): LeaderboardRangeKey {
  const raw = params.get("range");
  return raw && VALID_RANGES.has(raw as LeaderboardRangeKey)
    ? (raw as LeaderboardRangeKey)
    : "7d";
}

function readShowSystemFromParams(params: URLSearchParams): boolean {
  return params.get("system") === "1";
}

export function LeaderboardClient() {
  const searchParams = useSearchParams();

  // URL-backed state. Reads happen via `useSearchParams` on initial mount
  // (server-rendered + first client paint), but writes go through
  // `window.history.replaceState` — NOT `router.replace`. The App Router's
  // `router.replace` triggers an RSC payload refetch on the current segment
  // (`?_rsc=...`) every URL write, which adds ~700ms latency to range/filter
  // toggles. See AGENTS.md "URL state in client-only tables / filters" and
  // PR #314 for the regression that established this rule.
  const [range, setRange] = useState<LeaderboardRangeKey>(() =>
    readRangeFromParams(searchParams),
  );
  const [showSystem, setShowSystem] = useState<boolean>(() =>
    readShowSystemFromParams(searchParams),
  );

  const writeUrl = useCallback(
    (nextRange: LeaderboardRangeKey, nextShowSystem: boolean) => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      if (nextRange === "7d") params.delete("range");
      else params.set("range", nextRange);
      if (nextShowSystem) params.set("system", "1");
      else params.delete("system");
      const qs = params.toString();
      const nextUrl =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", nextUrl);
    },
    [],
  );

  const updateRange = useCallback(
    (next: LeaderboardRangeKey) => {
      setRange(next);
      writeUrl(next, showSystem);
    },
    [showSystem, writeUrl],
  );

  const updateShowSystem = useCallback(
    (next: boolean) => {
      setShowSystem(next);
      writeUrl(range, next);
    },
    [range, writeUrl],
  );

  // Browser back/forward buttons fire `popstate`. `replaceState` itself
  // doesn't (and Next's `useSearchParams` doesn't observe our writes), so
  // popstate is the only signal that real navigation moved the URL out from
  // under us — sync local state when it happens.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setRange((prev) => {
        const next = readRangeFromParams(params);
        return prev === next ? prev : next;
      });
      setShowSystem((prev) => {
        const next = readShowSystemFromParams(params);
        return prev === next ? prev : next;
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Memoize on `range` alone — `rangeCutoffSeconds` calls `Date.now()` and
  // would otherwise tick forward every render, creating a new SWR cache key
  // each second and triggering excess Hasura fetches. The window endpoint
  // being pinned to mount time is acceptable: daily snapshots only roll over
  // at UTC midnight, and SWR's 30s polling already keeps the data fresh.
  const cutoff = useMemo(() => rangeCutoffSeconds(range), [range]);
  const isSystemAddressIn = useMemo(
    () => (showSystem ? [false, true] : [false]),
    [showSystem],
  );

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
      updateRange(next === "all" ? "all" : next === "30d" ? "30d" : "7d");
    },
    [updateRange],
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

      {/* The chart only makes sense with multi-day data — the 24h window
          collapses to a single point and the chart's "1W / 1M / All" pill
          row would mismatch the visible series. */}
      {range !== "24h" && (
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
      )}

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
              Approximate top-N. Showing the top{" "}
              {ENVIO_MAX_ROWS.toLocaleString()} trader-day rows by single-day
              volume; high-frequency traders whose individual days don&apos;t
              crack this cap may be undercounted at longer windows. A pre-rolled
              window-snapshot entity is planned (see <code>BACKLOG.md</code>{" "}
              &rarr; PR 4).
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
