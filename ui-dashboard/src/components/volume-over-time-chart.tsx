"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { formatUSD } from "@/lib/format";
import { isFpmm } from "@/lib/tokens";
import { getSnapshotVolumeInUsd } from "@/lib/volume";
import type { NetworkData } from "@/hooks/use-all-networks-data";
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

type SeriesPoint = { timestamp: number; volumeUSD: number };

/**
 * Builds a daily volume series (UTC-day buckets) from 30d snapshots across all
 * networks. Volume is a flow: a bucket with no snapshots = 0 (no forward-fill,
 * unlike TVL). Only FPMMs contribute — virtual pools don't produce swap volume.
 */
export function buildDailyVolumeSeries(
  networkData: NetworkData[],
): SeriesPoint[] {
  const bucketTotals = new Map<number, number>();
  let earliestBucket = Infinity;

  for (const netData of networkData) {
    if (netData.error !== null || netData.snapshots30dError !== null) continue;
    const fpmmPoolIds = new Set(netData.pools.filter(isFpmm).map((p) => p.id));
    const poolById = new Map(netData.pools.map((p) => [p.id, p]));
    for (const snap of netData.snapshots30d) {
      if (!fpmmPoolIds.has(snap.poolId)) continue;
      const pool = poolById.get(snap.poolId);
      const volume = getSnapshotVolumeInUsd(
        snap,
        pool,
        netData.network,
        netData.rates,
      );
      if (volume === null) continue;
      const ts = Number(snap.timestamp);
      const bucket = Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      earliestBucket = Math.min(earliestBucket, bucket);
      bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + volume);
    }
  }

  if (!Number.isFinite(earliestBucket)) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;

  const series: SeriesPoint[] = [];
  for (let t = earliestBucket; t <= endBucket; t += SECONDS_PER_DAY) {
    series.push({ timestamp: t, volumeUSD: bucketTotals.get(t) ?? 0 });
  }
  return series;
}

interface VolumeOverTimeChartProps {
  networkData: NetworkData[];
  totalVolume7d: number | null;
  change7d: number | null;
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
}

export function VolumeOverTimeChart({
  networkData,
  totalVolume7d,
  change7d,
  isLoading,
  hasError,
  hasSnapshotError,
}: VolumeOverTimeChartProps) {
  const [range, setRange] = useState<RangeKey>("all");

  const fullSeries = useMemo<SeriesPoint[]>(
    () => buildDailyVolumeSeries(networkData),
    [networkData],
  );

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
    const ys = visibleSeries.map((p) => p.volumeUSD);
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
    const ymin = ys.length > 0 ? Math.min(...ys) : 0;
    const ymax = ys.length > 0 ? Math.max(...ys) : 1;
    // Floor the span at 1 so an all-zero series never produces [0, 0] (which
    // Plotly renders as a blank plot).
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

  const headline = isLoading
    ? "…"
    : totalVolume7d === null
      ? "N/A"
      : formatUSD(totalVolume7d);

  const deltaPill =
    change7d === null || isLoading || hasError ? null : (
      <span className={change7d >= 0 ? "text-emerald-400" : "text-red-400"}>
        {change7d >= 0 ? "+" : ""}
        {change7d.toFixed(2)}%
      </span>
    );

  const showEmptyState = !isLoading && fullSeries.length === 0;
  const emptyMessage = hasError
    ? "Unable to load volume history"
    : hasSnapshotError
      ? "Historical data partial — some chains failed to load"
      : "Not enough history yet";

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">Volume (past 7d)</p>
          <p className="mt-1 font-mono text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {headline}
          </p>
          <div className="mt-1 flex h-5 items-center gap-1.5 font-mono text-sm">
            {deltaPill}
            {deltaPill && (
              <span className="text-slate-500">week-over-week</span>
            )}
            {(hasError || hasSnapshotError) && !isLoading && (
              <span className="text-xs text-slate-500">· partial data</span>
            )}
          </div>
        </div>

        <div
          aria-label="Volume chart time range"
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
