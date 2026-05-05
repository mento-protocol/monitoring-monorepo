"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, type ReactNode } from "react";
import {
  escapePlotText,
  PLOTLY_BASE_LAYOUT,
  PLOTLY_CONFIG,
  ROW_CHART_HEIGHT_PX,
} from "@/lib/plot";
import { RANGES, type RangeKey, type TimeSeriesPoint } from "@/lib/time-series";

// A skeleton rendered while the Plotly chunk is still loading. Without this
// fallback there's a brief gap between `isLoading` flipping to false and the
// <Plot> chunk resolving — the card's plot area goes blank for a frame.
const PlotSkeleton = () => (
  <div
    className="animate-pulse rounded bg-slate-800/30"
    style={{ height: ROW_CHART_HEIGHT_PX }}
  />
);

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: PlotSkeleton,
});

export type BreakdownSeries = {
  name: string;
  color: string;
  series: TimeSeriesPoint[];
};

/** `stacked` suppresses the dedicated total trace (top of stack = total). */
export type BreakdownMode = "lines" | "stacked";

interface TimeSeriesChartCardProps {
  title: string;
  rangeAriaLabel: string;
  /**
   * The points to plot — callers are responsible for range-filtering this
   * themselves (`filterSeriesByRange` is exported for simple cutoff cases;
   * the Volume chart uses a rolling-window rebucketing strategy instead).
   */
  series: TimeSeriesPoint[];
  breakdown?: BreakdownSeries[];
  /** How to render the breakdown — defaults to `lines`. */
  breakdownMode?: BreakdownMode;
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
  /** String for simple "$X.XM" headlines, or a ReactNode for richer layouts
   *  (e.g. multi-value cells with inline badges). */
  headline: string | ReactNode;
  change: number | null;
  changeLabel?: string;
  /**
   * Plotly time-format string used in the hover tooltip. Default is
   * day-level (`%b %d, %Y`); charts with sub-day bucket granularity (e.g.
   * TVL's hourly 1W view) should pass a finer-grained format like
   * `%b %d, %H:00 UTC`.
   */
  hoverDateFormat?: string;
  isLoading: boolean;
  hasError: boolean;
  hasSnapshotError: boolean;
  emptyMessage: string;
}

export function TimeSeriesChartCard({
  title,
  rangeAriaLabel,
  series,
  breakdown,
  breakdownMode = "lines",
  range,
  onRangeChange,
  headline,
  change,
  changeLabel = "week-over-week",
  hoverDateFormat = "%b %d, %Y",
  isLoading,
  hasError,
  hasSnapshotError,
  emptyMessage,
}: TimeSeriesChartCardProps) {
  const hasBreakdown = (breakdown?.length ?? 0) > 0;
  const isStacked = hasBreakdown && breakdownMode === "stacked";
  // Track which breakdown traces the user has hidden via legend click. Used
  // only by the cross-fade renderer below (stacked mode + ≤3 breakdowns) —
  // otherwise Plotly's native legend toggle owns visibility.
  const [hiddenIdx, setHiddenIdx] = useState<Set<number>>(() => new Set());
  const breakdownCount = breakdown?.length ?? 0;
  // Cross-fade between pre-rendered visibility states. Pre-rendering 2^N
  // Plot instances stays fine perf-wise up to N=3 (8 plots, ~10KB SVG
  // each) — past that, fall back to a single chart with native toggle.
  const useCrossFade = isStacked && breakdownCount >= 1 && breakdownCount <= 3;
  const { traces, layout } = useMemo(() => {
    const xs = series.map((point) =>
      new Date(point.timestamp * 1000).toISOString(),
    );
    const ys = series.map((point) => point.value);
    const totalTrace = isStacked
      ? null
      : {
          x: xs,
          y: ys,
          name: hasBreakdown ? "Total" : undefined,
          type: "scatter" as const,
          mode: "lines" as const,
          line: { color: "#6366f1", width: 2 },
          fill: "tozeroy" as const,
          fillcolor: "rgba(99,102,241,0.08)",
          hovertemplate: `<b>$%{y:,.0f}</b><br>%{x|${hoverDateFormat}}<extra></extra>`,
        };
    const breakdownTraces = (breakdown ?? []).map((b) => {
      // Escape `name` before it reaches Plotly's `name` and `hovertemplate`
      // slots — both are HTML sinks per `lib/plot.ts:escapePlotText`.
      const safeName = escapePlotText(b.name);
      return {
        x: b.series.map((p) => new Date(p.timestamp * 1000).toISOString()),
        y: b.series.map((p) => p.value),
        name: safeName,
        type: "scatter" as const,
        mode: "lines" as const,
        ...(isStacked
          ? {
              stackgroup: "total",
              line: { color: b.color, width: 1.2 },
              // 8-digit hex = 6-digit color + "cc" alpha (≈80% opacity).
              // Assumes b.color is a 6-digit hex (the contract of chainColor()).
              fillcolor: b.color + "cc",
            }
          : {
              line: { color: b.color, width: 1 },
            }),
        hovertemplate: `${safeName}: $%{y:,.0f}<extra></extra>`,
      };
    });
    // Pull y-min toward 0 when a breakdown is present so smaller chains
    // don't get clipped off the bottom edge by the total-tight range.
    const breakdownYs = (breakdown ?? []).flatMap((b) =>
      b.series.map((p) => p.value),
    );
    // Use reduce rather than `Math.min(...arr)` — the spread form throws
    // RangeError above ~100k elements, which becomes reachable if hourly
    // bucketing or many chains land here later.
    const allYs = [...ys, ...breakdownYs];
    const ymin =
      allYs.length > 0 ? allYs.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    const ymax =
      allYs.length > 0 ? allYs.reduce((a, b) => Math.max(a, b), -Infinity) : 1;
    const span = Math.max(ymax - ymin, ymax * 0.02, 1);
    const yRange: [number, number] = [
      hasBreakdown ? 0 : Math.max(0, ymin - span * 0.1),
      ymax + span * 0.35,
    ];

    return {
      // Total is drawn first (background) so the per-chain lines stay
      // readable on top — its 2px line would otherwise clip whichever
      // chain tracks closest to it (e.g. Celo riding the TVL envelope).
      traces: totalTrace ? [totalTrace, ...breakdownTraces] : breakdownTraces,
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
          // Flat single-line tick label; without this Plotly draws a
          // secondary year label under each primary tick that gets clipped
          // to a dashed-looking fragment by the tight bottom margin.
          tickformat: "%b %d",
          fixedrange: true,
          // Hairline spike on breakdown charts only — single-trace consumers
          // (bridge / pool detail) keep Plotly's default-no-spike behavior.
          // 0.5px SVG stroke ≈ 1 device pixel on retina; the wider halo line
          // is suppressed in `globals.css` so this width isn't doubled.
          ...(hasBreakdown
            ? {
                showspikes: true,
                spikemode: "across" as const,
                spikethickness: 0.5,
                spikedash: "solid" as const,
                spikecolor: "#ffffff",
                spikesnap: "cursor" as const,
              }
            : {}),
        },
        yaxis: {
          showgrid: false,
          showticklabels: false,
          showline: false,
          zeroline: false,
          // Stacked mode uses Plotly's default `autorange` so the chart
          // re-fits when the user toggles a trace via legend click —
          // visibility changes route through Plotly's native handler
          // and the range recomputes from the visible stack max.
          // `lines` mode and single-trace charts keep the explicit
          // range with controlled hover-label headroom.
          ...(isStacked
            ? { autorange: true as const, rangemode: "tozero" as const }
            : { range: yRange }),
          fixedrange: true,
        },
        showlegend: hasBreakdown,
        legend: hasBreakdown
          ? {
              orientation: "h" as const,
              y: -0.15,
              x: 0,
              font: { color: "#94a3b8", size: 11 },
              bgcolor: "transparent",
            }
          : undefined,
        margin: { t: 8, r: 8, b: hasBreakdown ? 48 : 24, l: 8 },
        autosize: true,
        dragmode: false as const,
        // Unified hover only when there's a breakdown — single-trace charts
        // keep the per-trace tooltip placement they had before this PR.
        hovermode: hasBreakdown ? ("x unified" as const) : ("x" as const),
        hoverlabel: {
          bgcolor: "#0f172a",
          bordercolor: "#6366f1",
          font: { color: "#e2e8f0", size: 12, family: "inherit" },
        },
      },
    };
  }, [series, breakdown, hasBreakdown, isStacked, hoverDateFormat]);

  // Cross-fade in stacked mode: pre-render every visibility combo (2^N
  // total, minus the all-hidden state) as its own Plot with its own
  // y-range. Each combo's wrapper has CSS `opacity` 250ms-eased; the one
  // matching the user's current `hiddenIdx` is at opacity 1, the rest at
  // 0. Toggling a trace flips the active combo and CSS handles the
  // visual blend. This is the only animation path that produces a clean
  // grow/shrink for stacked-area charts — Plotly cannot interpolate
  // stackgroup y-values via `Plotly.react` + `layout.transition`.
  const crossFadeCombos = useMemo(() => {
    if (!useCrossFade) return [];
    const N = breakdownCount;
    const combos: Array<Set<number>> = [];
    // Skip the all-hidden combo (would be an empty chart) — that case
    // falls back to the empty-state render path below.
    for (let mask = 0; mask < (1 << N) - 1; mask++) {
      const set = new Set<number>();
      for (let i = 0; i < N; i++) if (mask & (1 << i)) set.add(i);
      combos.push(set);
    }
    return combos;
  }, [useCrossFade, breakdownCount]);

  const crossFadeData = useMemo(() => {
    if (!useCrossFade) return null;
    const xs = series.map((point) =>
      new Date(point.timestamp * 1000).toISOString(),
    );
    const breakdownArr = breakdown ?? [];
    return crossFadeCombos.map((combo) => {
      // Per-day stacked sum of VISIBLE traces — drives this combo's y-range.
      const dayBuckets = new Map<number, number>();
      breakdownArr.forEach((b, i) => {
        if (combo.has(i)) return;
        b.series.forEach((p) => {
          dayBuckets.set(
            p.timestamp,
            (dayBuckets.get(p.timestamp) ?? 0) + p.value,
          );
        });
      });
      const visibleMax = Array.from(dayBuckets.values()).reduce(
        (a, b) => Math.max(a, b),
        0,
      );
      const yRange: [number, number] = [0, Math.max(visibleMax * 1.1, 1)];

      const comboTraces = breakdownArr.map((b, i) => {
        const safeName = escapePlotText(b.name);
        return {
          x: b.series.map((p) => new Date(p.timestamp * 1000).toISOString()),
          y: b.series.map((p) => p.value),
          name: safeName,
          type: "scatter" as const,
          mode: "lines" as const,
          ...(combo.has(i) ? { visible: "legendonly" as const } : {}),
          stackgroup: "total",
          line: { color: b.color, width: 1.2 },
          fillcolor: b.color + "cc",
          hovertemplate: `${safeName}: $%{y:,.0f}<extra></extra>`,
        };
      });

      const comboLayout = {
        ...layout,
        yaxis: {
          ...layout.yaxis,
          range: yRange,
          autorange: false as const,
        },
      };
      // Mark unused vars (xs needed for non-stacked total trace path; not used here)
      void xs;
      return {
        key: [...combo].join(",") || "all",
        combo,
        traces: comboTraces,
        layout: comboLayout,
      };
    });
  }, [useCrossFade, series, breakdown, crossFadeCombos, layout]);

  // Returns false to suppress Plotly's native legend toggle so visibility
  // flows through React state (which drives the cross-fade). Only attached
  // to the active Plot in the cross-fade overlay path; native handler runs
  // unchanged for non-stacked / >3-trace charts.
  const handleLegendClick = (e: { readonly curveNumber: number }): boolean => {
    setHiddenIdx((prev) => {
      const next = new Set(prev);
      if (next.has(e.curveNumber)) next.delete(e.curveNumber);
      else next.add(e.curveNumber);
      return next;
    });
    return false;
  };

  const setEquals = (a: Set<number>, b: Set<number>) => {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  };

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
            {isLoading ? (
              // Pre-reserve the hero width so the transition from skeleton to
              // the real number doesn't shift the tab row on its right.
              <span className="inline-block h-[1em] w-36 animate-pulse rounded bg-slate-800/60 align-middle" />
            ) : (
              headline
            )}
          </p>
          <div className="mt-1 flex h-5 items-center gap-1.5 font-mono text-sm">
            {isLoading ? (
              <span className="h-3 w-24 animate-pulse rounded bg-slate-800/40" />
            ) : (
              <>
                {deltaPill}
                {deltaPill && (
                  <span className="text-slate-500">{changeLabel}</span>
                )}
                {(hasError || hasSnapshotError) && (
                  <span className="text-xs text-slate-500">· partial data</span>
                )}
              </>
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
                  "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
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
          <PlotSkeleton />
        ) : showEmptyState ? (
          <div
            className="flex items-center justify-center text-sm text-slate-500"
            style={{ height: ROW_CHART_HEIGHT_PX }}
          >
            {emptyMessage}
          </div>
        ) : useCrossFade && crossFadeData ? (
          <div style={{ position: "relative", height: ROW_CHART_HEIGHT_PX }}>
            {crossFadeData.map(({ key, combo, traces, layout }) => {
              const active = setEquals(combo, hiddenIdx);
              return (
                <div
                  key={key}
                  style={{
                    position: "absolute",
                    inset: 0,
                    opacity: active ? 1 : 0,
                    transition: "opacity 250ms ease-out",
                    pointerEvents: active ? "auto" : "none",
                  }}
                >
                  <Plot
                    data={traces}
                    layout={layout}
                    config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
                    style={{ width: "100%", height: ROW_CHART_HEIGHT_PX }}
                    useResizeHandler
                    onLegendClick={handleLegendClick}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <Plot
            data={traces}
            layout={layout}
            config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
            style={{ width: "100%", height: ROW_CHART_HEIGHT_PX }}
            useResizeHandler
          />
        )}
      </div>
    </section>
  );
}
