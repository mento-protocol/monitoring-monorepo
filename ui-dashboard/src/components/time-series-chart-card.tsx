"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

export const SECONDS_PER_DAY = 86_400;

export type RangeKey = "7d" | "30d";

export const RANGE_DAYS: Record<RangeKey, number> = {
  "7d": 7,
  "30d": 30,
};

const RANGES: ReadonlyArray<{
  key: RangeKey;
  label: string;
}> = [
  { key: "7d", label: "1W" },
  { key: "30d", label: "1M" },
];

export type TimeSeriesPoint = {
  timestamp: number;
  value: number;
};

export function filterSeriesByRange(
  series: readonly TimeSeriesPoint[],
  range: RangeKey,
): TimeSeriesPoint[] {
  const cutoff =
    Math.floor(Date.now() / 1000) - RANGE_DAYS[range] * SECONDS_PER_DAY;
  return series.filter((point) => point.timestamp >= cutoff);
}

interface TimeSeriesChartCardProps {
  title: string;
  rangeAriaLabel: string;
  series: TimeSeriesPoint[];
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
  headline: string;
  change: number | null;
  changeLabel?: string;
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
  emptyMessage: string;
}

export function TimeSeriesChartCard({
  title,
  rangeAriaLabel,
  series,
  range,
  onRangeChange,
  headline,
  change,
  changeLabel = "week-over-week",
  isLoading,
  hasError,
  hasSnapshotError,
  emptyMessage,
}: TimeSeriesChartCardProps) {
  const visibleSeries = useMemo(
    () => filterSeriesByRange(series, range),
    [range, series],
  );

  const { traces, layout } = useMemo(() => {
    const xs = visibleSeries.map((point) =>
      new Date(point.timestamp * 1000).toISOString(),
    );
    const ys = visibleSeries.map((point) => point.value);
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
    const span = Math.max(ymax - ymin, ymax * 0.02, 1);
    const yRange: [number, number] = [
      Math.max(0, ymin - span * 0.1),
      ymax + span * 0.35,
    ];

    return {
      traces: [trace],
      layout: {
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
      },
    };
  }, [visibleSeries]);

  const deltaPill =
    change === null || isLoading || hasError ? null : (
      <span className={change >= 0 ? "text-emerald-400" : "text-red-400"}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(2)}%
      </span>
    );

  const showEmptyState = !isLoading && series.length === 0;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">{title}</p>
          <p className="mt-1 font-mono text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {headline}
          </p>
          <div className="mt-1 flex h-5 items-center gap-1.5 font-mono text-sm">
            {deltaPill}
            {deltaPill && <span className="text-slate-500">{changeLabel}</span>}
            {(hasError || hasSnapshotError) && !isLoading && (
              <span className="text-xs text-slate-500">· partial data</span>
            )}
          </div>
        </div>

        <div
          role="group"
          aria-label={rangeAriaLabel}
          className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
        >
          {RANGES.map((item) => {
            const active = range === item.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => onRangeChange(item.key)}
                className={
                  "rounded px-3 py-1 text-xs font-medium transition-colors " +
                  (active
                    ? "bg-slate-700 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200")
                }
              >
                {item.label}
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
