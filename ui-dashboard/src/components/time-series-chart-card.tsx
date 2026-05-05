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

export type BreakdownSeries = {
  name: string;
  color: string;
  series: TimeSeriesPoint[];
  /**
   * Optional decorative element shown next to `name` in the legend AND
   * the custom hover tooltip. The leaderboard's per-pool chart uses
   * this to inline a chain icon (e.g. Celo / Monad mark) so the legend
   * stays compact — without the icon the names had to carry a
   * "· Celo" / "· Monad" suffix that wasted horizontal space.
   *
   * Whenever ANY breakdown series provides this, Plotly's built-in
   * legend is replaced with a custom React legend below the plot.
   * Plotly's SVG legend can't render arbitrary elements like SVG
   * icons, so we render the legend ourselves.
   */
  legendIcon?: ReactNode;
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
  headline: string;
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
   * 0.35 (35% headroom). Stacked charts that want peaks to fill more
   * of the plot can drop this to ~0.05–0.10. The bottom is always
   * pinned to 0 in stacked / breakdown mode regardless of this value.
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

  // Custom-tooltip state — only used when `customSortedHover` is on.
  // Plotly fires `plotly_hover` per-x; we collect the points, sort by
  // value, and render an absolutely-positioned div whose entries reflect
  // the hovered day's actual rank.
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    leftPx: number;
    topPx: number;
    dayLabel: string;
    points: Array<{
      name: string;
      value: number;
      color: string;
      legendIcon?: ReactNode;
    }>;
  } | null>(null);

  // Map of trace name → legendIcon for the hover handler. Plotly only
  // passes the trace's own data through `plotly_hover` events; React
  // nodes have to be looked up out-of-band.
  const legendIconByName = useMemo(() => {
    const m = new Map<string, ReactNode>();
    for (const b of breakdown ?? []) {
      if (b.legendIcon !== undefined) m.set(b.name, b.legendIcon);
    }
    return m;
  }, [breakdown]);

  const onPlotlyHover = useCallback(
    (e: {
      points?: unknown[];
      event?: { clientX?: number; clientY?: number };
    }) => {
      if (!customSortedHover) return;
      const rawPoints = (e.points ?? []) as Array<{
        x?: string | number;
        y?: number;
        fullData?: {
          name?: string;
          line?: { color?: string };
          fillcolor?: string;
        };
      }>;
      if (rawPoints.length === 0) return;
      const sorted = rawPoints
        .map((p) => {
          const name = p.fullData?.name ?? "";
          return {
            name,
            value: typeof p.y === "number" ? p.y : 0,
            // Stacked traces use `fillcolor` (with alpha suffix); strip
            // it for the legend swatch by falling back to `line.color`
            // first.
            color:
              p.fullData?.line?.color ??
              (p.fullData?.fillcolor
                ? p.fullData.fillcolor.replace(/cc$/i, "")
                : "#94a3b8"),
            legendIcon: legendIconByName.get(name),
          };
        })
        .sort((a, b) => b.value - a.value);
      const xRaw = rawPoints[0]?.x;
      const dayLabel =
        typeof xRaw === "string" || typeof xRaw === "number"
          ? new Date(xRaw).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
              timeZone: "UTC",
            })
          : "";
      const containerRect = containerRef.current?.getBoundingClientRect();
      const cx = e.event?.clientX ?? 0;
      const cy = e.event?.clientY ?? 0;
      setHover({
        leftPx: containerRect ? cx - containerRect.left : cx,
        topPx: containerRect ? cy - containerRect.top : cy,
        dayLabel,
        points: sorted,
      });
    },
    [customSortedHover, legendIconByName],
  );

  const onPlotlyUnhover = useCallback(() => {
    if (!customSortedHover) return;
    setHover(null);
  }, [customSortedHover]);
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
          range: yRange,
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
        {customSortedHover && hover && (
          <div
            // `whitespace-nowrap` prevents per-row name wrapping (e.g.
            // "USDC/USDm · Monad" used to break onto two lines because
            // the default flex `min-width: auto` allowed shrinking).
            // The dollar value is right-aligned via `ml-auto` so the
            // amount column stays visually consistent across rows.
            className="pointer-events-none absolute z-50 whitespace-nowrap rounded border border-indigo-500/60 bg-slate-950/95 px-2.5 py-2 text-[12px] text-slate-200 shadow-lg"
            style={{
              // Offset from the cursor a bit so the tooltip doesn't sit
              // under the pointer. Container has `position: relative`.
              left: hover.leftPx + 14,
              top: hover.topPx + 14,
            }}
          >
            <div className="mb-1 font-medium text-slate-300">
              {hover.dayLabel}
            </div>
            <div className="space-y-0.5">
              {hover.points.map((p) => (
                <div key={p.name} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 flex-shrink-0 rounded-sm"
                    style={{ background: p.color }}
                  />
                  {p.legendIcon && (
                    <span className="inline-flex flex-shrink-0 items-center">
                      {p.legendIcon}
                    </span>
                  )}
                  <span className="text-slate-400">{p.name}:</span>
                  <span className="ml-auto font-mono">
                    $
                    {p.value.toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {useCustomLegend && (
        <div
          // Wraps to a second row when the entries don't fit. Each chip
          // is its own flex item with `gap-x-3` between chips and
          // `gap-y-1` between rows when wrapping kicks in.
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400"
        >
          {(breakdown ?? []).map((b) => (
            <span
              key={b.name}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 flex-shrink-0 rounded-sm"
                style={{ background: b.color }}
              />
              {b.legendIcon && (
                <span className="inline-flex flex-shrink-0 items-center">
                  {b.legendIcon}
                </span>
              )}
              <span>{b.name}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
