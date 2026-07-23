"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  escapePlotText,
  PLOTLY_BASE_LAYOUT,
  PLOTLY_CONFIG,
  ROW_CHART_HEIGHT_PX,
} from "@/lib/plot";
import {
  RANGES,
  dateTickFormatForSeries,
  type RangeKey,
  type TimeSeriesPoint,
} from "@/lib/time-series";
import {
  CustomLegend,
  CustomSortedTooltip,
  type BreakdownSeries,
} from "@/components/time-series-chart-card-overlays";
import {
  useCrossFade,
  useSortedHover,
} from "@/components/time-series-chart-card-hooks";
import {
  useDeferredMount,
  type DeferredMountMode,
} from "@/components/use-deferred-mount";

export type { BreakdownSeries };
export type { DeferredMountMode as PlotlyDeferMode };

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
// the default 200px height. The plot container below compensates with
// `minHeight: chartHeightPx`, so taller charts (the volume page's 250px
// and 230px cards) don't shift content down when the chunk resolves.
const Plot = dynamic(() => import("@/lib/react-plotly-basic"), {
  ssr: false,
  loading: () => <PlotSkeleton />,
});

// Hoisted so the merged config keeps a stable identity across renders —
// react-plotly.js ref-compares data/layout/config and skips Plotly.react
// when all three are unchanged. An inline `{ ...PLOTLY_CONFIG, scrollZoom:
// false }` object is a fresh identity every render, scheduling a full
// chart redraw on every hover-state re-render.
const CHART_CARD_PLOTLY_CONFIG = {
  ...PLOTLY_CONFIG,
  scrollZoom: false,
} as const;

/** `stacked` suppresses the dedicated total trace (top of stack = total). */
type BreakdownMode = "lines" | "stacked";

const EMPTY_Y_AXIS_REFERENCE_VALUES: readonly number[] = [];

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
  /**
   * Whether the headline itself is still loading. Defaults to `isLoading`.
   * Use this when a card can paint an exact headline from server-prefetched
   * summary data while its chart series continues loading independently.
   */
  headlineLoading?: boolean;
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
   * volume page's per-pool stacked chart uses ~340 to let peaks reach
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
   *   bottom is a tight, non-zero floor (`Math.max(0, ymin - span * 0.1)`)
   *   whether or not a breakdown is present, so low-variance series stay
   *   visible instead of flattening against a zero baseline.
   * - **Stacked** charts (breakdownMode === "stacked"): the y-axis
   *   uses Plotly autorange so trace toggling can re-fit, so this
   *   value is *not* read by the y-axis math. It still controls the
   *   outer card bottom padding — values < 0.1 tighten the gap
   *   between the legend row and the card edge (the volume chart
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
   * volume page's per-pool stacked chart, which drops 1W in favor of
   * 3M — pass their own array here.
   */
  ranges?: ReadonlyArray<{ key: RangeKey; label: string }>;
  /** Plotly layout shapes, e.g. FX weekend closure bands. */
  shapes?: Plotly.Layout["shapes"];
  annotations?: Plotly.Layout["annotations"];
  yAxisReferenceValues?: readonly number[];
  plotlyDeferMode?: DeferredMountMode;
  /**
   * Whether the loading state reserves the delta sub-line (the row under the
   * headline showing the week-over-week change). Defaults to `true` (prior
   * behavior). Cards that always pass `change={null}` and never render a
   * delta once loaded should pass `false` so the loading phase doesn't
   * reserve a row the loaded phase never shows — that mismatch was a 25px
   * height jump on the /volume daily-volume card.
   */
  reserveDeltaRow?: boolean;
  /** Optional color override for the non-stacked aggregate trace. */
  totalLineColor?: string;
  /** Optional fill override for the non-stacked aggregate trace. */
  totalFillColor?: string;
}

// Intentional react-doctor suppression: chart shell + hover overlay + trace
// builder + range picker are tightly coupled to Plotly layout state. Revisit
// only with a focused chart-component split.
/* eslint-disable max-lines-per-function, complexity, sonarjs/cognitive-complexity -- Existing chart shell split is deferred; keep the suppression explicit instead of growing the baseline. */
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
  headlineLoading,
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
  shapes,
  annotations,
  yAxisReferenceValues = EMPTY_Y_AXIS_REFERENCE_VALUES,
  plotlyDeferMode = "none",
  reserveDeltaRow = true,
  totalLineColor = "#6366f1",
  totalFillColor = "rgba(99,102,241,0.08)",
}: TimeSeriesChartCardProps) {
  const resolvedHeadlineLoading = headlineLoading ?? isLoading;
  const hasBreakdown = (breakdown?.length ?? 0) > 0;
  const isStacked = hasBreakdown && breakdownMode === "stacked";
  // When any breakdown series carries a `legendIcon`, swap Plotly's
  // built-in legend for a custom React legend rendered below the plot.
  // Plotly's SVG legend can't render arbitrary React nodes (chain
  // icons, in our case).
  const useCustomLegend =
    hasBreakdown && (breakdown ?? []).some((b) => b.legendIcon !== undefined);

  const breakdownCount = breakdown?.length ?? 0;
  // Cross-fade between stacked visibility states. The shared state machine
  // mounts one Plot in steady state and only the incoming + outgoing pair
  // during the 250ms transition. The N<=3 eligibility gate remains unchanged;
  // larger native legends fall back to Plotly's own single-chart toggle.
  const crossFadeEnabled =
    isStacked && !useCustomLegend && breakdownCount >= 1 && breakdownCount <= 3;
  // Custom-legend visibility state. Keyed by `BreakdownSeries.id` (a
  // stable identity supplied by the caller — the volume page passes the
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
    // Plotly's own legend renders only when there's a breakdown AND the
    // host isn't drawing its own sibling legend. Hoisted so the layout's
    // `showlegend`, the conditional `legend` spread, and the bottom-margin
    // reservation stay in lockstep.
    const showPlotlyLegend = hasBreakdown && !useCustomLegend;
    const xs = series.map((point) =>
      new Date(point.timestamp * 1000).toISOString(),
    );
    const ys = series.map((point) => point.value);
    const tickformat = dateTickFormatForSeries(series);
    const totalTrace = isStacked
      ? null
      : {
          x: xs,
          y: ys,
          ...(hasBreakdown ? { name: "Total" } : {}),
          type: "scatter" as const,
          mode: "lines" as const,
          line: { color: totalLineColor, width: 2 },
          fill: "tozeroy" as const,
          fillcolor: totalFillColor,
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
    // Fold every breakdown series into the y-range inputs (`allYs` below)
    // so `ymin` is data-driven and covers all chains — the tight, non-zero
    // floor then can't clip a small chain off the bottom edge.
    const breakdownYs = (breakdown ?? []).flatMap((b) =>
      b.series.map((p) => p.value),
    );
    // Use reduce rather than `Math.min(...arr)` — the spread form throws
    // RangeError above ~100k elements, which becomes reachable if hourly
    // bucketing or many chains land here later.
    const allYs = [...ys, ...breakdownYs, ...yAxisReferenceValues];
    const ymin =
      allYs.length > 0 ? allYs.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    const ymax =
      allYs.length > 0 ? allYs.reduce((a, b) => Math.max(a, b), -Infinity) : 1;
    const span = Math.max(ymax - ymin, ymax * 0.02, 1);
    const yRange: [number, number] = [
      // Same tight, non-zero floor whether or not a breakdown is present.
      // Pinning the breakdown baseline to 0 made a low-variance TVL
      // envelope (~2% of a large total) move only 1-2px; the reduce-based
      // `ymin` already folds in every breakdown point via `allYs`, so no
      // small per-chain series is clipped off the bottom.
      Math.max(0, ymin - span * 0.1),
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
          tickformat,
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
        showlegend: showPlotlyLegend,
        ...(shapes ? { shapes } : {}),
        ...(annotations ? { annotations } : {}),
        ...(showPlotlyLegend
          ? {
              legend: {
                orientation: "h" as const,
                y: -0.15,
                x: 0,
                font: { color: "#94a3b8", size: 11 },
                bgcolor: "transparent",
              },
            }
          : {}),
        margin: {
          t: 8,
          r: 8,
          // Custom legend is rendered as a sibling below the Plot — no
          // need to reserve plot-margin space for Plotly's own legend.
          b: showPlotlyLegend ? 48 : 24,
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
    shapes,
    annotations,
    yAxisReferenceValues,
  ]);

  // Cross-fade in stacked mode: retain the current Plot while the requested
  // visibility state mounts at opacity 0, then swap the interactive target
  // and remove the outgoing Plot after 250ms. This is the only animation path
  // that produces a clean grow/shrink for stacked-area charts (Plotly cannot
  // interpolate stackgroup y-values via `Plotly.react`).
  const { handleLegendClick, crossFadeData } = useCrossFade({
    enabled: crossFadeEnabled,
    series,
    breakdown,
    baseLayout: layout,
  });
  const handleCrossFadeLegendClick = useCallback(
    (event: { readonly curveNumber: number }) => {
      // The /volume aggregator chart can combine cross-fade with the custom
      // sorted tooltip. Clear hover owned by the outgoing Plot before the hit
      // target swaps so its label cannot linger over the incoming state.
      onPlotlyUnhover();
      return handleLegendClick(event);
    },
    [handleLegendClick, onPlotlyUnhover],
  );

  const deltaPill =
    change === null || isLoading || hasError ? null : (
      <span className={change >= 0 ? "text-emerald-400" : "text-red-400"}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(2)}%
      </span>
    );

  const showEmptyState = !isLoading && series.length === 0;
  const shouldRenderPlot = !isLoading && !showEmptyState;
  const shouldMountPlot = useDeferredMount(
    plotlyDeferMode,
    containerRef,
    shouldRenderPlot,
  );

  // Accessible name + non-visual summary for the chart (WCAG 1.1.1). Both are
  // derived from live props (title + active range + week-over-week change) so
  // they can never drift from the rendered series. The summary deliberately
  // does NOT restate a specific value: consumers denominate their headline
  // differently (dollar range-totals, per-day latest, token amounts), so a
  // single formatter here would mislabel some of them — the trend direction +
  // range is the always-accurate signal. `role="figure"` on the plot container
  // gives it the concise `aria-label` as its accessible name and the sr-only
  // sibling below carries the summary, while leaving the interactive Plotly
  // controls (range selector/slider, legend) and axis text in the a11y tree.
  const activeRangeLabel =
    ranges.find((item) => item.key === range)?.label ?? String(range);
  const changeSummary =
    change === null || isLoading || hasError
      ? ""
      : `, ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(
          2,
        )}% ${changeLabel}`;
  const partialSummary =
    hasError || hasSnapshotError ? "; showing partial data" : "";
  const chartAriaLabel = `${title} chart, ${activeRangeLabel} range`;
  const chartSummary = isLoading
    ? `${title} chart is loading.`
    : series.length === 0
      ? `${title} chart: ${emptyMessage}`
      : `${title} chart over the ${activeRangeLabel} range${changeSummary}${partialSummary}.`;

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
          <p className="text-sm text-slate-400">
            {title}
            {/* Error affordance for cards that opt out of the delta row
                (`reserveDeltaRow={false}`): those cards never render the
                delta/error sub-line in any state (see the gated row below), so
                the "partial data" signal rides the always-present title line
                as an inline suffix instead of a row that would pop in — and
                add height — on the loading→error transition. Height-stable
                because it shares the title's text line. */}
            {!reserveDeltaRow && (hasError || hasSnapshotError) && (
              <span className="ml-1.5 text-xs text-slate-500">
                · partial data
              </span>
            )}
          </p>
          <p className="mt-1 font-mono text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {resolvedHeadlineLoading ? (
              // Pre-reserve the hero width so the transition from skeleton to
              // the real number doesn't shift the tab row on its right.
              <span className="inline-block h-[1em] w-36 animate-pulse rounded bg-slate-800/60 align-middle" />
            ) : (
              headline
            )}
          </p>
          {/* The change/error sub-line. `reserveDeltaRow` is an absolute
              gate: when it's false, this row never renders in ANY state
              (loading, loaded-clean, or loaded-with-error), so an opted-out
              card's header height is identical across all three — the error
              signal for those cards surfaces as the inline title suffix
              above instead. When `reserveDeltaRow` is true (default), the row
              is reserved while loading and, once loaded, shown whenever
              there's a delta pill or an error to report; an empty loaded-clean
              row is omitted so it doesn't waste ~20px pushing the plot down. */}
          {reserveDeltaRow &&
            (isLoading ||
              deltaPill !== null ||
              hasError ||
              hasSnapshotError) && (
              <div className="mt-1 flex h-5 items-center gap-1.5 font-mono text-sm">
                {isLoading ? (
                  <span className="inline-block h-5 w-16 animate-pulse rounded bg-slate-800/40 align-middle" />
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

      <div
        ref={containerRef}
        role="figure"
        aria-label={chartAriaLabel}
        className="relative mt-4 -mx-2 sm:-mx-3"
        // Reserve the final plot height even while next/dynamic's chunk
        // fallback (PlotSkeleton at the default 200px) is showing, so
        // charts taller than the default don't shift content down when
        // the Plotly chunk resolves. For the default-height cards this
        // equals the rendered height — a no-op, keeping homepage CLS 0.00.
        style={{ minHeight: chartHeightPx }}
      >
        {isLoading ? (
          <PlotSkeleton heightPx={chartHeightPx} />
        ) : showEmptyState ? (
          <div
            className="flex items-center justify-center text-sm text-slate-500"
            style={{ height: chartHeightPx }}
          >
            {emptyMessage}
          </div>
        ) : !shouldMountPlot ? (
          <PlotSkeleton heightPx={chartHeightPx} />
        ) : crossFadeEnabled && crossFadeData ? (
          <div style={{ position: "relative", height: chartHeightPx }}>
            {crossFadeData.map(({ key, active, traces, layout }) => {
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
                    ariaLabel={chartAriaLabel}
                    textAlternative={chartSummary}
                    ariaHidden={!active}
                    data={traces}
                    layout={layout}
                    config={CHART_CARD_PLOTLY_CONFIG}
                    style={{ width: "100%", height: chartHeightPx }}
                    useResizeHandler
                    onLegendClick={handleCrossFadeLegendClick}
                    // Forward hover events on both mounted layers. Only the
                    // active layer is visible/topmost, and legend retargeting
                    // clears custom hover before that hit target swaps.
                    onHover={onPlotlyHover}
                    onUnhover={onPlotlyUnhover}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <Plot
            ariaLabel={chartAriaLabel}
            textAlternative={chartSummary}
            data={traces}
            layout={layout}
            config={CHART_CARD_PLOTLY_CONFIG}
            style={{ width: "100%", height: chartHeightPx }}
            useResizeHandler
            onHover={onPlotlyHover}
            onUnhover={onPlotlyUnhover}
          />
        )}
        {customSortedHover && hover && <CustomSortedTooltip hover={hover} />}
      </div>
      {/* Non-visual text alternative for the chart. Sits outside the
          role="figure" container so screen readers announce the data summary
          as regular page content, alongside the figure's own accessible
          controls and axis/legend text. */}
      <p className="sr-only">{chartSummary}</p>
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
/* eslint-enable max-lines-per-function, complexity, sonarjs/cognitive-complexity */
