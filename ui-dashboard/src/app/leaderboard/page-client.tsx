"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useGQL } from "@/lib/graphql";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import { Tile } from "@/components/feedback";
import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import { formatUSD } from "@/lib/format";
import {
  POOL_DAILY_VOLUME,
  POOLS_FOR_LEADERBOARD,
  TRADER_DAILY_TOP,
} from "@/lib/queries/leaderboard";
import {
  LEADERBOARD_RANGES,
  aggregatePoolDailyVolume,
  aggregateTradersByWindow,
  rangeCutoffSeconds,
  rangeDays,
  weiToUsd,
  type LeaderboardRangeKey,
  type PoolDailyVolumeRow,
  type TraderDailyRow,
} from "@/lib/leaderboard";
import {
  LEADERBOARD_CHART_RANGES,
  SECONDS_PER_DAY,
  type RangeKey,
} from "@/lib/time-series";
import { networkForChainId } from "@/lib/networks";
import { poolName } from "@/lib/tokens";
import { LeaderboardTable } from "./_components/leaderboard-table";
import { TopPoolsList } from "./_components/top-pools-list";

type PoolRow = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
};

const VALID_RANGES = new Set<LeaderboardRangeKey>(["30d", "90d", "all"]);
const DEFAULT_RANGE: LeaderboardRangeKey = "30d";

function readRangeFromParams(params: URLSearchParams): LeaderboardRangeKey {
  const raw = params.get("range");
  return raw && VALID_RANGES.has(raw as LeaderboardRangeKey)
    ? (raw as LeaderboardRangeKey)
    : DEFAULT_RANGE;
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
      if (nextRange === DEFAULT_RANGE) params.delete("range");
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

  // `cutoff` only re-derives when `range` or the current UTC day changes.
  // Memoizing on `range` alone is not enough: `rangeCutoffSeconds` aligns
  // to UTC midnight, so a tab left open across midnight would keep firing
  // `_gte` queries against yesterday's boundary until the user reloaded
  // (codex finding 3183954662). We track UTC-day-of-mount via state and
  // bump it when a tick crosses midnight; the cache key flips at most
  // once per UTC day.
  const [utcDayKey, setUtcDayKey] = useState<number>(() =>
    Math.floor(Date.now() / 1000 / SECONDS_PER_DAY),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Poll once per minute — cheap, and the worst-case visible drift between
    // wall-clock midnight and the leaderboard updating is < 1 minute. We
    // can't `setTimeout` precisely to midnight because the user's tab may
    // be backgrounded and timers get throttled.
    const id = window.setInterval(() => {
      setUtcDayKey((prev) => {
        const next = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
        return next === prev ? prev : next;
      });
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  // `utcDayKey` is in the deps so the cutoff re-derives at midnight even
  // though it's not referenced inside the memo body — `rangeCutoffSeconds`
  // calls `Date.now()` internally and we need to flush the memo cache when
  // the day flips. Including the key is the cheapest way to express that.
  const cutoff = useMemo(() => rangeCutoffSeconds(range), [range, utcDayKey]);
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

  // Per-pool stacked chart data. Separate query from `TRADER_DAILY_TOP`
  // because the chart needs (poolId, day) granularity that the trader-day
  // rollup throws away. Sums to the same total per day across all traders
  // — pre-rolling `PoolDailyVolumeSnapshot` is the proper fix at scale
  // (`BACKLOG.md` PR 4).
  const poolVolumeResult = useGQL<{
    TraderPoolDailySnapshot: PoolDailyVolumeRow[];
  }>(POOL_DAILY_VOLUME, {
    afterTimestamp: cutoff,
    limit: ENVIO_MAX_ROWS,
  });

  const traderRows = tradersResult.data?.TraderDailySnapshot ?? [];
  const poolRows = poolsResult.data?.Pool ?? [];
  const poolVolumeRows = poolVolumeResult.data?.TraderPoolDailySnapshot ?? [];

  const aggregated = useMemo(
    () => aggregateTradersByWindow(traderRows),
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

  // When the system-address toggle is off, restrict the chart to rows
  // whose `(chainId, trader, day)` is in the parent trader query's
  // result. `TraderPoolDailySnapshot` doesn't carry an `isSystemAddress`
  // flag of its own, so the chart would otherwise include system flow
  // that the headline excludes (codex review). The allowlist is
  // day-scoped because `TraderDailySnapshot.isSystemAddress` is itself
  // day-scoped — a trader who flipped flag mid-window would otherwise
  // re-admit their excluded days into the chart (cursor agent finding
  // on 5fcc663). When the toggle is on we pass `undefined` to
  // short-circuit the filter.
  const traderAllowList = useMemo<ReadonlySet<string> | undefined>(() => {
    if (showSystem) return undefined;
    const s = new Set<string>();
    for (const r of traderRows) {
      if (r.isSystemAddress) continue;
      s.add(`${r.chainId}-${r.trader}-${r.timestamp}`);
    }
    return s;
  }, [showSystem, traderRows]);

  // UTC-day window range so the chart's x-axis stays contiguous when a
  // day had zero volume protocol-wide. `cutoff` is already aligned to
  // UTC midnight by `rangeCutoffSeconds`. `toSec` is today's UTC
  // midnight; the daily-rollover ticker (`utcDayKey`) flushes this memo
  // along with the cutoff at midnight.
  const windowRange = useMemo(() => {
    const todayMidnightUtc =
      Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    return cutoff > 0
      ? { fromSec: cutoff, toSec: todayMidnightUtc }
      : undefined;
    // utcDayKey is intentional — see `cutoff` memo above.
  }, [cutoff, utcDayKey]);

  const poolVolumeBreakdown = useMemo(() => {
    return aggregatePoolDailyVolume(
      poolVolumeRows,
      (poolId: string) => {
        const meta = poolMeta.get(poolId.toLowerCase());
        const [chainIdPart, addr] = poolId.split("-", 2);
        const network = chainIdPart
          ? networkForChainId(Number(chainIdPart))
          : null;
        if (network && meta) {
          // Pool name only — the chain is shown via the chain icon
          // in the legend / tooltip, so suffixing "· Celo" /
          // "· Monad" was redundant and burned legend horizontal
          // space (cross-chain disambiguation now lives at the
          // icon layer, not the text).
          return poolName(network, meta.token0, meta.token1);
        }
        // Fallback display when the pool isn't in our metadata cache
        // yet: `0x1234…5678` (first 6 + last 4 of addr).
        const a = addr ?? poolId;
        return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
      },
      traderAllowList,
      windowRange,
    );
  }, [poolVolumeRows, poolMeta, traderAllowList, windowRange]);

  // Decorate aggregator output with chain icons so the chart card can
  // render the legend (and tooltip) with chain marks instead of text
  // suffixes. `poolBreakdown.breakdown[i].key` is the poolId
  // (`{chainId}-{addr}`), so we extract the chainId for `networkForChainId`.
  // The chain icon at 16px + a 1-letter text badge is recognisable at
  // a glance — earlier the 12px icons looked near-identical for users
  // who weren't already familiar with the Celo/Monad marks, so two
  // legitimate cross-chain rows (e.g. USDC/USDm on both chains) read
  // as confusing duplicates.
  const chartBreakdown = useMemo(() => {
    return poolVolumeBreakdown.breakdown.map((b) => {
      const [chainIdPart] = b.key.split("-", 2);
      const network = chainIdPart
        ? networkForChainId(Number(chainIdPart))
        : null;
      return {
        name: b.name,
        color: b.color,
        series: b.series,
        // Chain name as a small uppercase right-aligned label. Chain
        // icons were dropped — they were too small to read at 12px and
        // visually conflated cross-chain pairs (USDC/USDm Celo vs
        // Monad). Plain text is unambiguous.
        legendIcon: network ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {network.label}
          </span>
        ) : null,
      };
    });
  }, [poolVolumeBreakdown]);

  // Top-pools sidebar list — top 10 by total window volume. Top-N
  // (where N = chart's TOP_N_POOLS) borrow the chart's stack color
  // for visual continuity; entries beyond that get null (rendered
  // muted by `<TopPoolsList>`).
  const topPoolsListEntries = useMemo(() => {
    const total = poolVolumeBreakdown.windowTotalUsdWei;
    // Build a lookup from poolId → chart color. Fast O(1) per row.
    const colorByPoolId = new Map<string, string>();
    for (const b of poolVolumeBreakdown.breakdown) {
      if (b.key !== "__other__") colorByPoolId.set(b.key, b.color);
    }
    return poolVolumeBreakdown.poolRanking.slice(0, 10).map((p) => {
      const meta = poolMeta.get(p.poolId.toLowerCase());
      const [chainIdPart, addr] = p.poolId.split("-", 2);
      const network = chainIdPart
        ? networkForChainId(Number(chainIdPart))
        : null;
      const name =
        network && meta
          ? poolName(network, meta.token0, meta.token1)
          : (addr ?? p.poolId).length > 12
            ? `${(addr ?? p.poolId).slice(0, 6)}…${(addr ?? p.poolId).slice(-4)}`
            : (addr ?? p.poolId);
      const share =
        total === BigInt(0)
          ? 0
          : // (totalUsdWei * 10000n) / total — keeps 4 decimals of
            // precision via BigInt before converting.
            Number((p.totalUsdWei * BigInt(10000)) / total) / 10000;
      return {
        poolId: p.poolId,
        name,
        chainBadge: network ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {network.label}
          </span>
        ) : null,
        totalUsd: p.totalUsd,
        share,
        color: colorByPoolId.get(p.poolId) ?? null,
      };
    });
  }, [poolVolumeBreakdown, poolMeta]);

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

  // Leaderboard ranges (`30d` / `90d` / `all`) line up 1:1 with the
  // chart's RangeKey, so this is now an identity passthrough — kept as
  // a separate variable so a future leaderboard-specific range that
  // doesn't map cleanly to a chart range stays easy to handle.
  const chartRange: RangeKey = range;
  const onChartRangeChange = useCallback(
    (next: RangeKey) => {
      // The chart's range pills are `LEADERBOARD_CHART_RANGES`
      // (30d/90d/all), so any value here is a valid LeaderboardRangeKey.
      if (next === "30d" || next === "90d" || next === "all") {
        updateRange(next);
      }
    },
    [updateRange],
  );

  const isLoading = tradersResult.isLoading || poolsResult.isLoading;
  const hasError = !!tradersResult.error;
  // The trader-day and pool-day queries saturate the Hasura 1000-row
  // cap independently. The KPI tiles (totalVolume, totalTraders,
  // top10Concentration) are derived ONLY from `aggregated` →
  // `traderRows` → `TRADER_DAILY_TOP`, so they're approximate iff
  // `traderCapHit`. The chart is derived from `POOL_DAILY_VOLUME`, so
  // it's approximate iff `poolCapHit`. Conflating the two over-flagged
  // tiles when only the chart query was capped (codex finding on
  // 5fcc663). The banner above the tiles fires when EITHER source is
  // capped so the user knows something on the page is approximate.
  const traderCapHit =
    !!tradersResult.data &&
    (tradersResult.data.TraderDailySnapshot?.length ?? 0) === ENVIO_MAX_ROWS;
  const chartCapHit =
    !!poolVolumeResult.data &&
    (poolVolumeResult.data.TraderPoolDailySnapshot?.length ?? 0) ===
      ENVIO_MAX_ROWS;
  const anyCapHit = traderCapHit || chartCapHit;

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

      {/* Banner fires when EITHER query is capped, so users know SOME
          surface on the page is approximate. Tile labels and value
          prefixes only flip when the trader query is capped (the
          source they actually derive from); the chart card has its
          own approximation badge driven by `chartCapHit`. */}
      {anyCapHit && (
        <div className="rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90">
          <strong className="font-medium">
            Approximate values for this window.
          </strong>{" "}
          Showing the top {ENVIO_MAX_ROWS.toLocaleString()}{" "}
          {traderCapHit && chartCapHit
            ? "trader-day and pool-day"
            : traderCapHit
              ? "trader-day"
              : "pool-day"}{" "}
          rows by single-day volume — high-frequency contributors whose
          individual days don&apos;t crack the cap may be undercounted at longer
          windows. A pre-rolled window-snapshot entity is planned (
          <code>BACKLOG.md</code> &rarr; PR 4).
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile
          label={traderCapHit ? "Total volume (≈)" : "Total volume"}
          value={
            isLoading
              ? "…"
              : hasError
                ? "—"
                : `${traderCapHit ? "≈ " : ""}${formatUSD(totalVolume)}`
          }
          subtitle={rangeSubtitle(range)}
        />
        <Tile
          label={traderCapHit ? "Unique traders (≈)" : "Unique traders"}
          value={
            isLoading
              ? "…"
              : hasError
                ? "—"
                : `${traderCapHit ? "≥ " : ""}${totalTraders.toLocaleString()}`
          }
          subtitle={`${totalSwaps.toLocaleString()} swaps`}
        />
        <Tile
          label={
            traderCapHit ? "Top-10 concentration (≈)" : "Top-10 concentration"
          }
          value={
            isLoading
              ? "…"
              : hasError
                ? "—"
                : `${top10Concentration.toFixed(1)}%`
          }
          subtitle="Share of window volume"
        />
      </div>

      {/* Chart (2/3) + top-pools list (1/3). The chart answers "which
          pools contribute how much, on which days?"; the list answers
          "what's the leaderboard order over the whole window?". On
          screens narrower than `lg`, both stack to full width. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
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
            isLoading={isLoading || poolVolumeResult.isLoading}
            hasError={hasError || !!poolVolumeResult.error}
            hasSnapshotError={false}
            emptyMessage="No pool volume in this window."
            // Taller plot + minimal top padding so peaks reach close
            // to the headline figure instead of bottoming out in 1/3
            // of the available card area.
            chartHeightPx={300}
            yAxisTopPadding={0}
            // Sort hover-tooltip entries by the hovered day's volume
            // desc — Plotly's native unified hover uses fixed trace
            // order (rank by total window volume), which doesn't
            // match what's visually largest on a given day.
            customSortedHover
          />
        </div>
        <div className="lg:col-span-1">
          <TopPoolsList
            entries={topPoolsListEntries}
            isLoading={isLoading || poolVolumeResult.isLoading}
            hasError={hasError || !!poolVolumeResult.error}
            windowLabel={rangeLabel(range)}
          />
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-300">
          Top traders ({rangeLabel(range)})
        </h2>
        <LeaderboardTable
          cutoff={cutoff}
          traders={aggregated}
          pools={poolMeta}
          isLoading={isLoading}
          hasError={hasError}
        />
      </section>
    </div>
  );
}

function rangeSubtitle(range: LeaderboardRangeKey): string {
  if (range === "all") return "All time";
  const days = rangeDays(range);
  return `Last ${days} days`;
}

function rangeLabel(range: LeaderboardRangeKey): string {
  if (range === "30d") return "1M";
  if (range === "90d") return "3M";
  return "all-time";
}
