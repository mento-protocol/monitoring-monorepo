"use client";

import type { ReactNode } from "react";
import type { BreakdownSeries } from "@/components/time-series-chart-card";

/**
 * Custom React legend rendered below the plot in lieu of Plotly's
 * built-in SVG legend. Used when any `BreakdownSeries` carries a
 * `legendIcon` (chain badges, etc.) — Plotly's legend can't render
 * arbitrary React nodes. The chip layout is `[swatch] [icon?]
 * [name]`; chips wrap to a second row when they don't fit.
 *
 * Extracted out of `TimeSeriesChartCard` so the parent stays under
 * the AGENTS.md 600-line file-size budget.
 */
export function CustomLegend({
  breakdown,
}: {
  breakdown: readonly BreakdownSeries[];
}) {
  return (
    <div
      // Wraps to a second row when the entries don't fit. Each chip is
      // its own flex item with `gap-x-3` between chips and `gap-y-1`
      // between rows when wrapping kicks in.
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400"
    >
      {breakdown.map((b) => (
        <span
          // Composite key — same reason as the tooltip's row key: pool
          // pairs (e.g. "EURm/USDm") can repeat across chains.
          key={`${b.color}-${b.name}`}
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
  );
}

export type SortedHoverPoint = {
  name: string;
  value: number;
  color: string;
  legendIcon?: ReactNode;
};

export type SortedHoverState = {
  leftPx: number;
  topPx: number;
  dayLabel: string;
  points: SortedHoverPoint[];
};

/**
 * Custom React tooltip for stacked charts that need per-day-sorted
 * entries (Plotly's `x unified` hover lists traces in fixed
 * data-array order). Layout: `[swatch] [name] ··· [value (right)]
 * [legendIcon (right)]`.
 *
 * Position is absolute relative to the chart container. Caller is
 * responsible for ensuring the container has `position: relative`.
 */
export function CustomSortedTooltip({ hover }: { hover: SortedHoverState }) {
  return (
    <div
      // `whitespace-nowrap` prevents per-row name wrapping (e.g.
      // long pool names with chain suffixes) — default flex
      // `min-width: auto` would otherwise shrink the name column
      // under the dollar column.
      className="pointer-events-none absolute z-50 whitespace-nowrap rounded border border-indigo-500/60 bg-slate-950/95 px-2.5 py-2 text-[12px] text-slate-200 shadow-lg"
      style={{
        // Offset from the cursor a bit so the tooltip doesn't sit
        // under the pointer.
        left: hover.leftPx + 14,
        top: hover.topPx + 14,
      }}
    >
      <div className="mb-1 font-medium text-slate-300">{hover.dayLabel}</div>
      <div className="space-y-0.5">
        {hover.points.map((p) => (
          // Composite key — `name` alone collides when the same pool
          // pair (e.g. "EURm/USDm") exists on multiple chains. Color
          // is unique per trace via `POOL_PALETTE` assignment, so
          // `${color}-${name}` is collision-free.
          <div key={`${p.color}-${p.name}`} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 flex-shrink-0 rounded-sm"
              style={{ background: p.color }}
            />
            <span className="text-slate-400">{p.name}</span>
            <span className="ml-auto font-mono">
              $
              {p.value.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
            {p.legendIcon && (
              <span className="inline-flex flex-shrink-0 items-center">
                {p.legendIcon}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
