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
  // Track which breakdown traces the user has hidden via legend click.
  // Stacked-mode only — non-stacked uses Plotly's default toggle handling.
  // Indices map to the breakdown[] array (no offset; the total trace is
  // suppressed in stacked mode, so curveNumber == breakdown index).
  const [hiddenBreakdownIdx, setHiddenBreakdownIdx] = useState<Set<number>>(
    () => new Set(),
  );
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
    const breakdownTraces = (breakdown ?? []).map((b, i) => {
      // Escape `name` before it reaches Plotly's `name` and `hovertemplate`
      // slots — both are HTML sinks per `lib/plot.ts:escapePlotText`.
      const safeName = escapePlotText(b.name);
      const hidden = isStacked && hiddenBreakdownIdx.has(i);
      // When hidden, animate the trace's y-values to 0 instead of using
      // `visible: "legendonly"`. Reasoning: legendonly removes the trace
      // from the stack instantly while the y-axis range eases — so the
      // remaining trace's *position* and the *axis* desync mid-animation,
      // producing the "grows-then-shrinks" / "outside-chart" weirdness
      // the user flagged. With y→0, the hidden trace's contribution to
      // the stack monotonically decays, the visible trace's stack base
      // monotonically falls toward zero, and Plotly interpolates
      // everything (y-values + range) on the same timeline. The hidden
      // trace's line/fill desaturate to a muted slate tone so the legend
      // swatch reads as "off" (Plotly draws the legend marker from
      // line.color).
      return {
        x: b.series.map((p) => new Date(p.timestamp * 1000).toISOString()),
        y: hidden ? b.series.map(() => 0) : b.series.map((p) => p.value),
        name: safeName,
        type: "scatter" as const,
        mode: "lines" as const,
        ...(isStacked
          ? {
              stackgroup: "total",
              line: { color: hidden ? "#475569" : b.color, width: 1.2 },
              // 8-digit hex = 6-digit color + "cc" alpha (≈80% opacity).
              // Assumes b.color is a 6-digit hex (the contract of chainColor()).
              // When hidden the fillcolor goes fully transparent so the
              // collapsed-to-zero band doesn't leave a visible 1px line
              // sitting on the x-axis.
              fillcolor: hidden ? "transparent" : b.color + "cc",
            }
          : {
              line: { color: b.color, width: 1 },
            }),
        // Skip the hover label for hidden traces — otherwise the unified
        // tooltip lists "v2: $0" for every cursor sample, which is
        // misleading (the user toggled it off, not "v2 had no volume").
        ...(hidden
          ? { hoverinfo: "skip" as const }
          : { hovertemplate: `${safeName}: $%{y:,.0f}<extra></extra>` }),
      };
    });
    // Stacked-mode y-range = max per-day sum of VISIBLE breakdown traces +
    // headroom. Computing this explicitly (rather than using `autorange`)
    // is required for the toggle animation: `layout.transition` interpolates
    // an explicit range change, but autorange recomputation runs outside
    // the transition pipeline and snaps.
    const stackedYRange: [number, number] | null = isStacked
      ? (() => {
          const dayBuckets = new Map<number, number>();
          (breakdown ?? []).forEach((b, i) => {
            if (hiddenBreakdownIdx.has(i)) return;
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
          // 10% headroom keeps the top of the stack from kissing the
          // chart's top edge; 1 is the floor so an all-zero series still
          // gets a visible y-range.
          return [0, Math.max(visibleMax * 1.1, 1)];
        })()
      : null;
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
          // Stacked mode uses an explicit range computed from VISIBLE
          // traces only, recomputed on every legend toggle. Explicit (not
          // autorange) is required for the transition animation —
          // `layout.transition` interpolates a range change, autorange
          // bypasses the transition pipeline and snaps.
          range: stackedYRange ?? yRange,
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
        // Smooth y-axis re-fit when stacked-breakdown traces are toggled
        // via the legend (e.g. hiding v2 lets v3 grow to fill the card).
        // Plotly applies `layout.transition` to its restyle/relayout
        // pipeline; legend clicks are restyle events. Skipped for non-
        // stacked charts since they have no multi-trace toggle UX and
        // animating a single-trace range change is just visual noise on
        // initial mount.
        ...(isStacked
          ? {
              transition: {
                // `back-in-out` adds the small "anticipation" overshoot
                // the user asked for — the stack briefly moves a few
                // pixels in the opposite direction before settling, which
                // reads as "gathering momentum" rather than the linear
                // grows-then-shrinks of `cubic-in-out`.
                duration: 450,
                easing: "back-in-out" as const,
              },
            }
          : {}),
      },
    };
  }, [
    series,
    breakdown,
    hasBreakdown,
    isStacked,
    hoverDateFormat,
    hiddenBreakdownIdx,
  ]);

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
        ) : (
          <Plot
            data={traces}
            layout={layout}
            // Intercept legend clicks in stacked mode so visibility flows
            // through React state → `Plotly.react`, which honors
            // `layout.transition`. Returning false suppresses Plotly's
            // own (non-animated) toggle.
            onLegendClick={
              isStacked
                ? (e: { curveNumber: number }) => {
                    setHiddenBreakdownIdx((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.curveNumber)) next.delete(e.curveNumber);
                      else next.add(e.curveNumber);
                      return next;
                    });
                    return false;
                  }
                : undefined
            }
            config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
            style={{ width: "100%", height: ROW_CHART_HEIGHT_PX }}
            useResizeHandler
          />
        )}
      </div>
    </section>
  );
}
