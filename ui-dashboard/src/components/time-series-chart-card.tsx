"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  escapePlotText,
  PLOTLY_BASE_LAYOUT,
  PLOTLY_CONFIG,
  ROW_CHART_HEIGHT_PX,
} from "@/lib/plot";
import { RANGES, type RangeKey, type TimeSeriesPoint } from "@/lib/time-series";
import {
  CustomLegend,
  CustomSortedTooltip,
  type BreakdownSeries,
} from "@/components/time-series-chart-card-overlays";
import {
  setEquals,
  useCrossFade,
  useSortedHover,
} from "@/components/time-series-chart-card-hooks";

export type { BreakdownSeries };

// A skeleton rendered while the Plotly chunk is still loading. Without this
// fallback there's a brief gap between `isLoading` flipping to false and the
// <Plot> chunk resolving — the card's plot area goes blank for a frame.
function PlotSkeleton({
  heightPx = ROW_CHART_HEIGHT_PX,
}: {
  heightPx?: number;
}) {
  return (
    <div
      className="animate-pulse rounded bg-slate-800/30"
      style={{ height: heightPx }}
    />
  );
}

// `dynamic`'s `loading` prop receives `DynamicOptionsLoadingProps`, not
// our custom `{ heightPx }`, so the chunk-loading flash falls back to
// the default 200px height. That's a 1-frame visual nit before
// hydration; not worth threading the height through.
const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => <PlotSkeleton />,
});

/** `stacked` suppresses the dedicated total trace (top of stack = total). */
type BreakdownMode = "lines" | "stacked";

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
  /**
   * Plot area height in pixels. Defaults to `ROW_CHART_HEIGHT_PX` (200).
   * Charts that want more vertical real estate can override — the
   * leaderboard's per-pool stacked chart uses ~340 to let peaks reach
   * close to the headline figure instead of bottoming out in 1/3 of
   * the available card height.
   */
  chartHeightPx?: number;
  /**
   * Top-of-axis padding as a fraction of the y-range span. Defaults to
   * 0.35 (35% headroom).
   *
   * Two effects:
   * - **Non-stacked / single-trace** charts: drives the explicit
   *   `yaxis.range` upper bound (`ymax + span * yAxisTopPadding`). The
   *   bottom is pinned to 0 when a breakdown is present.
   * - **Stacked** charts (breakdownMode === "stacked"): the y-axis
   *   uses Plotly autorange so trace toggling can re-fit, so this
   *   value is *not* read by the y-axis math. It still controls the
   *   outer card bottom padding — values < 0.1 tighten the gap
   *   between the legend row and the card edge (the leaderboard chart
   *   passes 0 for this reason).
   */
  yAxisTopPadding?: number;
  /**
   * When true, suppress Plotly's built-in x-unified hover label and
   * render a custom React tooltip whose entries are sorted by the
   * value at the hovered x. Plotly's native unified hover lists traces
   * in fixed (data-array) order — for stacked charts that order is
   * "rank by total window volume", which doesn't match the user's
   * mental model when they want to see "what was biggest TODAY".
   */
  customSortedHover?: boolean;
  /**
   * Custom range pill set, defaulting to the global `RANGES`
   * (`1W / 1M / All`). Charts with a different cadence — e.g. the
   * leaderboard's per-pool stacked chart, which drops 1W in favor of
   * 3M — pass their own array here.
   */
  ranges?: ReadonlyArray<{ key: RangeKey; label: string }>;
}

// Intentional react-doctor suppression: chart shell + hover overlay + trace
// builder + range picker are tightly coupled to Plotly layout state. Revisit
// only with a focused chart-component split. Same rationale silences
// `max-lines-per-function` on this function + its inner useMemo (the
// merge-base baseline embeds line counts in its messages, which would
// otherwise flag every size change as a new violation).
/* eslint-disable max-lines-per-function */
// react-doctor-disable-next-line react-doctor/no-giant-component
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
  chartHeightPx = ROW_CHART_HEIGHT_PX,
  yAxisTopPadding = 0.35,
  customSortedHover = false,
  ranges = RANGES,
}: TimeSeriesChartCardProps) {
  const hasBreakdown = (breakdown?.length ?? 0) > 0;
  const isStacked = hasBreakdown && breakdownMode === "stacked";
  // When any breakdown series carries a `legendIcon`, swap Plotly's
  // built-in legend for a custom React legend rendered below the plot.
  // Plotly's SVG legend can't render arbitrary React nodes (chain
  // icons, in our case).
  const useCustomLegend =
    hasBreakdown && (breakdown ?? []).some((b) => b.legendIcon !== undefined);

  const breakdownCount = breakdown?.length ?? 0;
  // Cross-fade between pre-rendered visibility states. Pre-rendering
  // 2^N Plot instances stays fine perf-wise up to N=3 (8 plots, ~10KB
  // SVG each) — past that, fall back to a single chart with native
  // toggle. Cross-fade requires Plotly's native legend (we toggle
  // visibility by clicking it); custom-legend mode owns its own
  // visibility via React state and a different render path.
  const crossFadeEnabled =
    isStacked && !useCustomLegend && breakdownCount >= 1 && breakdownCount <= 3;
  // Custom-legend visibility state. Keyed by `BreakdownSeries.id` (a
  // stable identity supplied by the caller — the leaderboard passes the
  // poolId) so user intent ("hide USDC/USDm Monad") survives both
  // breakdown reshuffles (cursor finding on 88147ad) AND the rank-based
  // color/name churn that can happen after a range switch (codex finding
  // on b259ee9). When the caller doesn't supply `id`, falls back to
  // `${color}-${name}` as a best-effort key.
  const [customLegendHidden, setCustomLegendHidden] = useState<Set<string>>(
    () => new Set(),
  );
  const customLegendKey = useCallback(
    (b: BreakdownSeries) => b.id ?? `${b.color}-${b.name}`,
    [],
  );
  const toggleCustomLegend = useCallback((key: string) => {
    setCustomLegendHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Custom-tooltip state — only used when `customSortedHover` is on.
  // The hook collects Plotly hover points, sorts by value, and exposes
  // `hover` / `onHover` / `onUnhover` for the JSX below to wire up.
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    hover,
    onHover: onPlotlyHover,
    onUnhover: onPlotlyUnhover,
  } = useSortedHover({
    enabled: customSortedHover,
    isStacked,
    breakdown,
    containerRef,
  });
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
      // Custom-legend mode hides traces by re-rendering with `visible:
      // "legendonly"` rather than going through Plotly's native click
      // handler (the native legend is suppressed, so we own visibility
      // via React state).
      const hidden =
        useCustomLegend && customLegendHidden.has(customLegendKey(b));
      return {
        x: b.series.map((p) => new Date(p.timestamp * 1000).toISOString()),
        y: b.series.map((p) => p.value),
        name: safeName,
        type: "scatter" as const,
        mode: "lines" as const,
        ...(hidden ? { visible: "legendonly" as const } : {}),
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
        // Custom React tooltip mode: `hoverinfo: "none"` suppresses
        // Plotly's built-in label visually while keeping `plotly_hover`
        // events firing. We also drop `hovertemplate` entirely — per
        // Plotly's API, a non-empty `hovertemplate` overrides
        // `hoverinfo` and re-enables the native label, defeating the
        // purpose. Default mode keeps `hovertemplate` for the
        // x-unified hover.
        ...(customSortedHover
          ? { hoverinfo: "none" as const }
          : {
              hovertemplate: `${safeName}: $%{y:,.0f}<extra></extra>`,
            }),
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
      ymax + span * yAxisTopPadding,
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
        showlegend: hasBreakdown && !useCustomLegend,
        legend:
          hasBreakdown && !useCustomLegend
            ? {
                orientation: "h" as const,
                y: -0.15,
                x: 0,
                font: { color: "#94a3b8", size: 11 },
                bgcolor: "transparent",
              }
            : undefined,
        margin: {
          t: 8,
          r: 8,
          // Custom legend is rendered as a sibling below the Plot — no
          // need to reserve plot-margin space for Plotly's own legend.
          b: hasBreakdown && !useCustomLegend ? 48 : 24,
          l: 8,
        },
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
  }, [
    series,
    breakdown,
    hasBreakdown,
    isStacked,
    hoverDateFormat,
    yAxisTopPadding,
    customSortedHover,
    useCustomLegend,
    customLegendHidden,
    customLegendKey,
  ]);

  // Cross-fade in stacked mode: pre-render every visibility combo (2^N
  // total) as its own Plot, CSS-fade between them on legend click. Only
  // animation path that produces a clean grow/shrink for stacked-area
  // charts (Plotly cannot interpolate stackgroup y-values via
  // `Plotly.react` + `layout.transition`).
  const { hiddenIdx, handleLegendClick, crossFadeData } = useCrossFade({
    enabled: crossFadeEnabled,
    breakdownCount,
    series,
    breakdown,
    baseLayout: layout,
  });

  const deltaPill =
    change === null || isLoading || hasError ? null : (
      <span className={change >= 0 ? "text-emerald-400" : "text-red-400"}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(2)}%
      </span>
    );

  const showEmptyState = !isLoading && series.length === 0;

  return (
    <section
      className={
        "rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6 " +
        // Dense-layout charts (low `yAxisTopPadding`) reduce the bottom
        // padding so the legend doesn't sit far above the card edge —
        // the user's stacked chart was 33px from the legend to the
        // card's lower border with the default `p-6` (24px). Other
        // cards keep the symmetric padding.
        (yAxisTopPadding < 0.1 ? "pb-2 sm:pb-3" : "")
      }
    >
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
          {/* Reserve the change-pill row only when there's something to
              show — when the caller passes `change={null}` and the chart
              isn't in loading or error state, this row is empty and just
              wastes ~20px of vertical real estate that pushes the plot
              area down (per-pool stacked chart's headline-to-peak gap
              feedback). */}
          {(isLoading ||
            deltaPill !== null ||
            hasError ||
            hasSnapshotError) && (
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
                    <span className="text-xs text-slate-500">
                      · partial data
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div
          role="group"
          aria-label={rangeAriaLabel}
          className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
        >
          {ranges.map((item) => {
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

      <div ref={containerRef} className="relative mt-4 -mx-2 sm:-mx-3">
        {isLoading ? (
          <PlotSkeleton heightPx={chartHeightPx} />
        ) : showEmptyState ? (
          <div
            className="flex items-center justify-center text-sm text-slate-500"
            style={{ height: chartHeightPx }}
          >
            {emptyMessage}
          </div>
        ) : crossFadeEnabled && crossFadeData ? (
          <div style={{ position: "relative", height: chartHeightPx }}>
            {crossFadeData.map(({ key, combo, traces, layout }) => {
              const active = setEquals(combo, hiddenIdx);
              return (
                <div
                  key={key}
                  style={{
                    position: "absolute",
                    inset: 0,
                    opacity: active ? 1 : 0,
                    // Plotly attaches inline `pointer-events: all` to its
                    // drag rect on every overlay, which overrides the
                    // container's `pointer-events: none`. Without
                    // `visibility: hidden`, the topmost overlay (the
                    // all-traces-hidden combo) intercepts hover and its
                    // empty Plotly draws no label. Delay the visibility
                    // flip past the opacity fade so the cross-fade still
                    // reads when leaving active.
                    visibility: active ? "visible" : "hidden",
                    // Lift the active overlay above fading-out siblings so
                    // its Plotly drag rect is the topmost hit target during
                    // the 250ms fade — without this, the previously-active
                    // overlay (still `visibility: visible` until the delayed
                    // flip) can intercept hover and draw a stale label.
                    zIndex: active ? 1 : 0,
                    transition: active
                      ? "opacity 250ms ease-out"
                      : "opacity 250ms ease-out, visibility 0s 250ms",
                    pointerEvents: active ? "auto" : "none",
                  }}
                >
                  <Plot
                    data={traces}
                    layout={layout}
                    config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
                    style={{ width: "100%", height: chartHeightPx }}
                    useResizeHandler
                    onLegendClick={handleLegendClick}
                    // Forward Plotly hover events on the active overlay
                    // so a future caller using both crossFade + custom-
                    // sorted-hover gets the React tooltip wired up. No
                    // current caller hits both (custom-sorted-hover
                    // implies legendIcon → useCustomLegend → cross-fade
                    // disabled), but cursor flagged the asymmetry.
                    onHover={onPlotlyHover}
                    onUnhover={onPlotlyUnhover}
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
            style={{ width: "100%", height: chartHeightPx }}
            useResizeHandler
            onHover={onPlotlyHover}
            onUnhover={onPlotlyUnhover}
          />
        )}
        {customSortedHover && hover && <CustomSortedTooltip hover={hover} />}
      </div>
      {useCustomLegend && (
        <CustomLegend
          breakdown={breakdown ?? []}
          hiddenIdx={customLegendHidden}
          keyFor={customLegendKey}
          onToggle={toggleCustomLegend}
        />
      )}
    </section>
  );
}
/* eslint-enable max-lines-per-function */
