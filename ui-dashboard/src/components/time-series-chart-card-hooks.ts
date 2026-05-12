"use client";

import { useCallback, useMemo, useState } from "react";
import { escapePlotText } from "@/lib/plot";
import type {
  BreakdownSeries,
  SortedHoverState,
} from "@/components/time-series-chart-card-overlays";

export type ChartLayout = Record<string, unknown> & {
  yaxis: Record<string, unknown>;
};

export type CrossFadeCombo = {
  key: string;
  combo: Set<number>;
  traces: Array<Record<string, unknown>>;
  layout: ChartLayout;
};

/**
 * Pre-render every visibility combo (2^N total) of a stacked breakdown
 * chart. Each combo carries its own y-range so toggling traces produces
 * a CSS-eased grow/shrink — Plotly cannot interpolate stackgroup y-values
 * via `Plotly.react` + `layout.transition`. Only enabled when the parent
 * uses Plotly's native legend (custom-legend mode owns its own visibility
 * state) and breakdown count is small enough that 2^N plot instances
 * stay cheap (≤3 → 8 plots).
 *
 * Returns:
 * - `hiddenIdx` / `setHiddenIdx` — current trace-visibility state.
 * - `handleLegendClick` — Plotly legend handler that toggles visibility
 *   through React state instead of Plotly's internal toggle (returns
 *   `false` to suppress the native handler).
 * - `crossFadeData` — null when disabled; an array of pre-computed combo
 *   { traces, layout } when active. Caller renders one Plot per combo
 *   stacked absolutely, with `opacity` driven by which combo matches
 *   `hiddenIdx`.
 */
export function useCrossFade(params: {
  enabled: boolean;
  breakdownCount: number;
  series: ReadonlyArray<{ timestamp: number; value: number }>;
  breakdown: ReadonlyArray<BreakdownSeries> | undefined;
  baseLayout: ChartLayout;
}): {
  hiddenIdx: Set<number>;
  setHiddenIdx: React.Dispatch<React.SetStateAction<Set<number>>>;
  handleLegendClick: (e: { readonly curveNumber: number }) => boolean;
  crossFadeData: CrossFadeCombo[] | null;
} {
  const { enabled, breakdownCount, series, breakdown, baseLayout } = params;
  const [hiddenIdx, setHiddenIdx] = useState<Set<number>>(() => new Set());

  const combos = useMemo(() => {
    if (!enabled) return [];
    const out: Array<Set<number>> = [];
    for (let mask = 0; mask < 1 << breakdownCount; mask++) {
      const set = new Set<number>();
      for (let i = 0; i < breakdownCount; i++) if (mask & (1 << i)) set.add(i);
      out.push(set);
    }
    return out;
  }, [enabled, breakdownCount]);

  const crossFadeData = useMemo<CrossFadeCombo[] | null>(() => {
    if (!enabled) return null;
    const breakdownArr = breakdown ?? [];
    return combos.map((combo) => {
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

      const comboLayout: ChartLayout = {
        ...baseLayout,
        yaxis: {
          ...baseLayout.yaxis,
          range: yRange,
          autorange: false as const,
        },
      };
      void series; // referenced for memo dep correctness (timestamps drive bucket keys)
      return {
        key: [...combo].join(",") || "all",
        combo,
        traces: comboTraces,
        layout: comboLayout,
      };
    });
  }, [enabled, series, breakdown, combos, baseLayout]);

  // Returns false to suppress Plotly's native legend toggle so visibility
  // flows through React state (which drives the cross-fade).
  const handleLegendClick = (e: { readonly curveNumber: number }): boolean => {
    setHiddenIdx((prev) => {
      const next = new Set(prev);
      if (next.has(e.curveNumber)) next.delete(e.curveNumber);
      else next.add(e.curveNumber);
      return next;
    });
    return false;
  };

  return { hiddenIdx, setHiddenIdx, handleLegendClick, crossFadeData };
}

export function setEquals<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Custom React tooltip for stacked charts that need per-day-sorted
 * entries (Plotly's `x unified` hover lists traces in fixed
 * data-array order, which on a stacked chart is "rank by total window
 * volume" — not what users want to see for "biggest contributor TODAY").
 *
 * Returns the hover state and the `plotly_hover`/`plotly_unhover`
 * handlers to wire to `<Plot>`. Caller renders `<CustomSortedTooltip>`
 * absolutely-positioned inside the chart container.
 */
export function useSortedHover(params: {
  enabled: boolean;
  isStacked: boolean;
  breakdown: ReadonlyArray<BreakdownSeries> | undefined;
  containerRef: React.RefObject<HTMLDivElement | null>;
}): {
  hover: SortedHoverState | null;
  onHover: (e: {
    points?: unknown[];
    event?: { clientX?: number; clientY?: number };
  }) => void;
  onUnhover: () => void;
} {
  const { enabled, isStacked, breakdown, containerRef } = params;
  const [hover, setHover] = useState<SortedHoverState | null>(null);

  const onHover = useCallback(
    (e: {
      points?: unknown[];
      event?: { clientX?: number; clientY?: number };
    }) => {
      if (!enabled) return;
      const rawPoints = (e.points ?? []) as Array<{
        x?: string | number;
        curveNumber?: number;
        pointIndex?: number;
      }>;
      if (rawPoints.length === 0) return;
      // Dedupe by `curveNumber` — Plotly occasionally emits the same
      // trace twice in `x unified` mode for stacked areas, producing
      // doubled rows. `curveNumber` is the canonical per-trace id; first
      // hit wins.
      const seenCurves = new Set<number>();
      const uniquePoints = rawPoints.filter((p) => {
        const cn = p.curveNumber ?? -1;
        if (seenCurves.has(cn)) return false;
        seenCurves.add(cn);
        return true;
      });
      // Look up everything by `(curveNumber, pointIndex)` directly from
      // the BreakdownSeries we passed in. Reading `point.y` on stacked
      // traces is risky: Plotly's stacked rendering can diverge from the
      // input value near cap boundaries. Sourcing from
      // `breakdown[i].series[pointIndex]` guarantees we display the same
      // numbers we computed upstream.
      const breakdownByCurve = breakdown ?? [];
      // In stacked mode `traces = breakdownTraces` (1:1). In non-stacked
      // mode `traces = [totalTrace, ...breakdownTraces]`, so the total
      // trace occupies index 0 and `breakdown[curveNumber - 1]` is the
      // underlying series.
      const breakdownIndexOffset = isStacked ? 0 : 1;
      const points = uniquePoints.flatMap((p) => {
        const cn = p.curveNumber;
        const pi = p.pointIndex;
        const idx = typeof cn === "number" ? cn - breakdownIndexOffset : -1;
        const b = idx >= 0 ? breakdownByCurve[idx] : undefined;
        // Filter the totalTrace point (curveNumber 0 in non-stacked mode):
        // no `breakdown[]` entry, so name would be empty — drop it.
        if (!b?.name) return [];
        const seriesPoint = typeof pi === "number" ? b.series[pi] : undefined;
        return [
          {
            name: b.name,
            value: seriesPoint?.value ?? 0,
            color: b.color ?? "#94a3b8",
            legendIcon: b.legendIcon,
          },
        ];
      });
      // ES2023 `Array.prototype.toSorted` would be cleaner but requires
      // Safari 16+ / Chrome 110+; the dashboard's compile target is
      // ES2017 with no polyfill, so keep the cloned `sort()` form to
      // stay compatible with older browsers (codex P2, PR #371).
      // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
      const sorted = [...points].sort((a, b) => b.value - a.value);
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
    [enabled, breakdown, isStacked, containerRef],
  );

  const onUnhover = useCallback(() => {
    if (!enabled) return;
    setHover(null);
  }, [enabled]);

  return { hover, onHover, onUnhover };
}
