"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
import type { Network } from "@/lib/networks";
import type { OracleRateMap } from "@/lib/tokens";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const SECONDS_PER_DAY = 86_400;

type RangeKey = "7d" | "30d" | "all";

const RANGES: ReadonlyArray<{
  key: RangeKey;
  label: string;
  days: number | null;
}> = [
  { key: "7d", label: "1W", days: 7 },
  { key: "30d", label: "1M", days: 30 },
  { key: "all", label: "All", days: null },
];

type SeriesPoint = { timestamp: number; tvlUSD: number };

type PoolHistory = {
  pool: Pool;
  network: Network;
  rates: OracleRateMap;
  points: Array<{ ts: number; r0: string; r1: string }>;
};

/**
 * Builds a daily TVL time series from 30d snapshots by forward-filling per-pool
 * reserves and using current oracle rates. This isolates reserve-quantity
 * movements (matches the approach in matchedTvl() in page.tsx). Also returns
 * `nowTvl` computed from the same pool set using live reserves, so the chart's
 * "now" endpoint uses the same denominator as the historical buckets.
 */
export function buildDailySeries(networkData: NetworkData[]): {
  series: SeriesPoint[];
  nowTvl: number;
} {
  const histories: PoolHistory[] = [];
  let earliestTs = Infinity;

  for (const netData of networkData) {
    if (netData.error !== null || netData.snapshots30dError !== null) continue;
    const fpmmPools = netData.pools.filter(isFpmm);
    const snapsByPool = new Map<string, PoolSnapshotWindow[]>();
    for (const snap of netData.snapshots30d) {
      const list = snapsByPool.get(snap.poolId);
      if (list) list.push(snap);
      else snapsByPool.set(snap.poolId, [snap]);
    }
    for (const pool of fpmmPools) {
      const raw = snapsByPool.get(pool.id);
      if (!raw || raw.length === 0) continue;
      const points = raw
        .map((s) => ({
          ts: Number(s.timestamp),
          r0: s.reserves0,
          r1: s.reserves1,
        }))
        .sort((a, b) => a.ts - b.ts);
      earliestTs = Math.min(earliestTs, points[0].ts);
      histories.push({
        pool,
        network: netData.network,
        rates: netData.rates,
        points,
      });
    }
  }

  if (histories.length === 0) return { series: [], nowTvl: 0 };

  const nowSec = Math.floor(Date.now() / 1000);
  const startDay = Math.floor(earliestTs / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const endDay = Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;

  const cursors = new Array<number>(histories.length).fill(-1);
  const series: SeriesPoint[] = [];

  for (let t = startDay; t <= endDay; t += SECONDS_PER_DAY) {
    let tvl = 0;
    for (let i = 0; i < histories.length; i++) {
      const h = histories[i];
      // Bucket t represents the END of UTC day t — include any snapshot whose
      // timestamp falls anywhere in [t, t + SECONDS_PER_DAY). Using `<= t`
      // would exclude mid-day snapshots and produce a synthetic zero on the
      // first bucket whenever the earliest in-range snapshot isn't exactly at
      // midnight (which is the typical hour-aligned case from the indexer).
      while (
        cursors[i] + 1 < h.points.length &&
        h.points[cursors[i] + 1].ts < t + SECONDS_PER_DAY
      ) {
        cursors[i]++;
      }
      if (cursors[i] < 0) continue;
      const pt = h.points[cursors[i]];
      tvl += poolTvlUSD(
        { ...h.pool, reserves0: pt.r0, reserves1: pt.r1 },
        h.network,
        h.rates,
      );
    }
    series.push({ timestamp: t, tvlUSD: tvl });
  }

  // "Now" TVL computed from the SAME pool set (snapshot-backed) using each
  // pool's live reserves0/reserves1. This guarantees the chart endpoint shares
  // a denominator with the historical buckets — pools without snapshots are
  // excluded from both, so a new pool can't create a phantom right-edge cliff.
  let nowTvl = 0;
  for (const h of histories) {
    nowTvl += poolTvlUSD(h.pool, h.network, h.rates);
  }

  return { series, nowTvl };
}

interface TvlOverTimeChartProps {
  networkData: NetworkData[];
  totalTvl: number;
  change24h: number | null;
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
}

export function TvlOverTimeChart({
  networkData,
  totalTvl,
  change24h,
  isLoading,
  hasError,
  hasSnapshotError,
}: TvlOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("all");

  const fullSeries = useMemo<SeriesPoint[]>(() => {
    const { series: base, nowTvl } = buildDailySeries(networkData);
    if (base.length === 0) return [];
    // Append a live "now" point using the SAME pool set as the historical
    // buckets so the chart endpoint shares a denominator with every prior
    // point. The headline `totalTvl` (all FPMMs) may exceed this endpoint when
    // pools exist without snapshots yet — that gap self-heals as snapshots
    // accumulate.
    const nowSec = Math.floor(Date.now() / 1000);
    return [...base, { timestamp: nowSec, tvlUSD: nowTvl }];
  }, [networkData]);

  const visibleSeries = useMemo(() => {
    const r = RANGES.find((x) => x.key === range)!;
    if (r.days === null) return fullSeries;
    const cutoff = Math.floor(Date.now() / 1000) - r.days * SECONDS_PER_DAY;
    return fullSeries.filter((p) => p.timestamp >= cutoff);
  }, [fullSeries, range]);

  const { traces, layout } = useMemo(() => {
    const xs = visibleSeries.map((p) =>
      new Date(p.timestamp * 1000).toISOString(),
    );
    const ys = visibleSeries.map((p) => p.tvlUSD);
    const trace = {
      x: xs,
      y: ys,
      type: "scatter" as const,
      mode: "lines" as const,
      line: { color: "#6366f1", width: 2 },
      fill: "tozeroy" as const,
      fillcolor: "rgba(99,102,241,0.08)",
      hovertemplate: `<b>$%{y:,.0f}</b><br>%{x|%b %d, %Y}<extra></extra>`,
    };
    // Give the line headroom so it doesn't sit flush at the top of the plot on
    // stable periods. Larger top pad than bottom pad biases the line below the
    // top edge regardless of variance.
    const ymin = ys.length > 0 ? Math.min(...ys) : 0;
    const ymax = ys.length > 0 ? Math.max(...ys) : 1;
    // Floor the span at 1 so an all-zero series never produces [0, 0] (which
    // Plotly renders as a blank plot). Real-data spans always dominate the floor.
    const span = Math.max(ymax - ymin, ymax * 0.02, 1);
    const yRange: [number, number] = [
      Math.max(0, ymin - span * 0.1),
      ymax + span * 0.35,
    ];
    const l = {
      ...PLOTLY_BASE_LAYOUT,
      font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
      xaxis: {
        type: "date" as const,
        showgrid: false,
        showline: false,
        zeroline: false,
        linecolor: "transparent",
        tickcolor: "transparent",
        tickfont: { size: 10, color: "#64748b" },
        nticks: 5,
        fixedrange: true,
      },
      yaxis: {
        showgrid: false,
        showticklabels: false,
        showline: false,
        zeroline: false,
        range: yRange,
        fixedrange: true,
      },
      showlegend: false,
      margin: { t: 8, r: 8, b: 24, l: 8 },
      autosize: true,
      dragmode: false as const,
      hovermode: "x" as const,
      hoverlabel: {
        bgcolor: "#0f172a",
        bordercolor: "#6366f1",
        font: { color: "#e2e8f0", size: 12, family: "inherit" },
      },
    };
    return { traces: [trace], layout: l };
  }, [visibleSeries]);

  const headline = isLoading ? "…" : formatUSD(totalTvl);

  // Suppress the delta pill on top-level chain failure — the headline TVL is
  // computed from the surviving chain subset, so the delta isn't trustworthy.
  const deltaPill =
    change24h === null || isLoading || hasError ? null : (
      <span className={change24h >= 0 ? "text-emerald-400" : "text-red-400"}>
        {change24h >= 0 ? "+" : ""}
        {change24h.toFixed(2)}%
      </span>
    );

  const showEmptyState = !isLoading && fullSeries.length === 0;
  const emptyMessage = hasError
    ? "Unable to load TVL history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : "Not enough history yet";

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">Total Value Locked</p>
          <p className="mt-1 font-mono text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {headline}
          </p>
          <div className="mt-1 flex h-5 items-center gap-1.5 font-mono text-sm">
            {deltaPill}
            {deltaPill && <span className="text-slate-500">past 24h</span>}
            {(hasError || hasSnapshotError) && !isLoading && (
              <span className="text-xs text-slate-500">· partial data</span>
            )}
          </div>
        </div>

        <div
          aria-label="TVL chart time range"
          className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
        >
          {RANGES.map((r) => {
            const active = range === r.key;
            return (
              <button
                key={r.key}
                type="button"
                aria-pressed={active}
                onClick={() => setRange(r.key)}
                className={
                  "rounded px-3 py-1 text-xs font-medium transition-colors " +
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
      </div>

      <div className="mt-4 -mx-2 sm:-mx-3">
        {isLoading ? (
          <div className="h-[200px] animate-pulse rounded bg-slate-800/30" />
        ) : showEmptyState ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-slate-500">
            {emptyMessage}
          </div>
        ) : (
          <Plot
            data={traces}
            layout={layout}
            config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
            style={{ width: "100%", height: 200 }}
            useResizeHandler
          />
        )}
      </div>
    </section>
  );
}
