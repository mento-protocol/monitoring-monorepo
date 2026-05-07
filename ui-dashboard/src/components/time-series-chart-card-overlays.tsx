"use client";

import type { ReactNode } from "react";
import type { TimeSeriesPoint } from "@/lib/time-series";

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

/**
 * Custom React legend rendered below the plot in lieu of Plotly's
 * built-in SVG legend. Used when any `BreakdownSeries` carries a
 * `legendIcon` (chain badges, etc.) — Plotly's legend can't render
 * arbitrary React nodes. Click a chip to hide that trace; click again
 * to restore.
 */
export function CustomLegend({
  breakdown,
  hiddenIdx,
  onToggle,
}: {
  breakdown: readonly BreakdownSeries[];
  hiddenIdx: ReadonlySet<number>;
  onToggle: (idx: number) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
      {breakdown.map((b, i) => {
        const hidden = hiddenIdx.has(i);
        return (
          <button
            // Composite key — pool pairs (e.g. "EURm/USDm") can repeat
            // across chains, so name alone collides.
            key={`${b.color}-${b.name}`}
            type="button"
            aria-pressed={!hidden}
            onClick={() => onToggle(i)}
            className={
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 " +
              (hidden ? "opacity-40 line-through" : "opacity-100")
            }
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 flex-shrink-0 rounded-sm"
              style={{ background: b.color }}
            />
            <span>{b.name}</span>
            {b.legendIcon && (
              <span className="inline-flex flex-shrink-0 items-center">
                {b.legendIcon}
              </span>
            )}
          </button>
        );
      })}
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
 * data-array order). Layout: `[swatch] [name] [legendIcon] ···
 * [value (rightmost)]`.
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
            {/* Layout: [swatch] [name] [chain (left)] ··· [value
                (right)]. Chain badge sits next to the name with the
                default flex gap; value is right-aligned via `ml-auto`. */}
            {p.legendIcon && (
              <span className="inline-flex flex-shrink-0 items-center">
                {p.legendIcon}
              </span>
            )}
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
  );
}
