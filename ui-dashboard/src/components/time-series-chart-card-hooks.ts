"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { sortedCopy } from "@/lib/immutable-sort";
import { escapePlotText } from "@/lib/plot";
import type {
  BreakdownSeries,
  SortedHoverState,
} from "@/components/time-series-chart-card-overlays";

export type ChartLayout = Record<string, unknown> & {
  yaxis: Record<string, unknown>;
};

export type CrossFadePlot = {
  key: string;
  active: boolean;
  traces: Array<Record<string, unknown>>;
  layout: ChartLayout;
};

const CROSS_FADE_DURATION_MS = 250;

type CrossFadePhase = "steady" | "preparing" | "fading";

type CrossFadeState = {
  desiredHiddenKeys: Set<string>;
  activeHiddenKeys: Set<string>;
  secondaryHiddenKeys: Set<string> | null;
  phase: CrossFadePhase;
  transitionId: number;
};

type CrossFadeAction =
  | { type: "toggle"; seriesKey: string; reduceMotion: boolean }
  | { type: "start"; transitionId: number }
  | { type: "finish"; transitionId: number }
  | { type: "reset" };

function initialCrossFadeState(): CrossFadeState {
  return {
    desiredHiddenKeys: new Set(),
    activeHiddenKeys: new Set(),
    secondaryHiddenKeys: null,
    phase: "steady",
    transitionId: 0,
  };
}

function crossFadeReducer(
  state: CrossFadeState,
  action: CrossFadeAction,
): CrossFadeState {
  if (action.type === "reset") return initialCrossFadeState();

  if (action.type === "toggle") {
    const desiredHiddenKeys = new Set(state.desiredHiddenKeys);
    if (desiredHiddenKeys.has(action.seriesKey)) {
      desiredHiddenKeys.delete(action.seriesKey);
    } else {
      desiredHiddenKeys.add(action.seriesKey);
    }
    const transitionId = state.transitionId + 1;

    // A retarget back to the currently interactive layer needs no fade. The
    // same immediate settle honors reduced motion without mounting a second
    // Plot (or leaving a timer/listener behind).
    if (
      action.reduceMotion ||
      setEquals(desiredHiddenKeys, state.activeHiddenKeys)
    ) {
      return {
        desiredHiddenKeys,
        activeHiddenKeys: desiredHiddenKeys,
        secondaryHiddenKeys: null,
        phase: "steady",
        transitionId,
      };
    }

    // Keep the currently interactive Plot mounted while the latest target is
    // inserted at opacity 0. Replacing (rather than appending) the secondary
    // slot is what keeps rapid retargets bounded at two Plot instances.
    return {
      desiredHiddenKeys,
      activeHiddenKeys: state.activeHiddenKeys,
      secondaryHiddenKeys: desiredHiddenKeys,
      phase: "preparing",
      transitionId,
    };
  }

  if (
    action.type === "start" &&
    state.phase === "preparing" &&
    action.transitionId === state.transitionId &&
    state.secondaryHiddenKeys
  ) {
    return {
      ...state,
      activeHiddenKeys: state.secondaryHiddenKeys,
      secondaryHiddenKeys: state.activeHiddenKeys,
      phase: "fading",
    };
  }

  if (
    action.type === "finish" &&
    state.phase === "fading" &&
    action.transitionId === state.transitionId
  ) {
    return {
      ...state,
      secondaryHiddenKeys: null,
      phase: "steady",
    };
  }

  return state;
}

function buildCrossFadePlot({
  hiddenKeys,
  currentBreakdown,
  baseLayout,
  active,
}: {
  hiddenKeys: ReadonlySet<string>;
  currentBreakdown: ReadonlyArray<BreakdownSeries>;
  baseLayout: ChartLayout;
  active: boolean;
}): CrossFadePlot {
  const combo = hiddenSeriesKeysToIndexes(currentBreakdown, hiddenKeys);
  const dayBuckets = new Map<number, number>();
  currentBreakdown.forEach((breakdownSeries, index) => {
    if (combo.has(index)) return;
    breakdownSeries.series.forEach((point) => {
      dayBuckets.set(
        point.timestamp,
        (dayBuckets.get(point.timestamp) ?? 0) + point.value,
      );
    });
  });
  const visibleMax = Array.from(dayBuckets.values()).reduce(
    (maximum, value) => Math.max(maximum, value),
    0,
  );
  const yRange: [number, number] = [0, Math.max(visibleMax * 1.1, 1)];

  const traces = currentBreakdown.map((breakdownSeries, index) => {
    const safeName = escapePlotText(breakdownSeries.name);
    return {
      x: breakdownSeries.series.map((point) =>
        new Date(point.timestamp * 1000).toISOString(),
      ),
      y: breakdownSeries.series.map((point) => point.value),
      name: safeName,
      type: "scatter" as const,
      mode: "lines" as const,
      ...(combo.has(index) ? { visible: "legendonly" as const } : {}),
      stackgroup: "total",
      line: { color: breakdownSeries.color, width: 1.2 },
      fillcolor: breakdownSeries.color + "cc",
      hovertemplate: `${safeName}: $%{y:,.0f}<extra></extra>`,
    };
  });

  return {
    key: [...combo].join(",") || "all",
    active,
    traces,
    layout: {
      ...baseLayout,
      yaxis: {
        ...baseLayout.yaxis,
        range: yRange,
        autorange: false as const,
      },
    },
  };
}

/**
 * Build only the current and transitioning visibility states of a stacked
 * breakdown chart. Each state carries its own y-range so toggling traces
 * produces a CSS-eased grow/shrink — Plotly cannot interpolate stackgroup
 * y-values via `Plotly.react` + `layout.transition`.
 *
 * Returns:
 * - `handleLegendClick` — Plotly legend handler that toggles visibility
 *   through React state instead of Plotly's internal toggle (returns
 *   `false` to suppress the native handler).
 * - `crossFadeData` — null when disabled; otherwise exactly one Plot in
 *   steady state and at most two during the 250ms transition.
 */
export function useCrossFade(params: {
  enabled: boolean;
  series: ReadonlyArray<{ timestamp: number; value: number }>;
  breakdown: ReadonlyArray<BreakdownSeries> | undefined;
  baseLayout: ChartLayout;
}): {
  handleLegendClick: (e: { readonly curveNumber: number }) => boolean;
  crossFadeData: CrossFadePlot[] | null;
} {
  const { enabled, series, breakdown, baseLayout } = params;
  const currentBreakdown = useMemo(() => breakdown ?? [], [breakdown]);
  const [fadeState, dispatchFade] = useReducer(
    crossFadeReducer,
    undefined,
    initialCrossFadeState,
  );

  // Reset and cancel transition work when the caller leaves the eligible
  // cross-fade path (for example, a breakdown grows past the N<=3 gate).
  useEffect(() => {
    if (!enabled) dispatchFade({ type: "reset" });
  }, [enabled]);

  // The target Plot must commit once at opacity 0 before becoming active;
  // otherwise a newly mounted node starts at opacity 1 and cannot fade in.
  useEffect(() => {
    if (!enabled || fadeState.phase !== "preparing") return;
    const transitionId = fadeState.transitionId;
    const frame = requestAnimationFrame(() => {
      dispatchFade({ type: "start", transitionId });
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, fadeState.phase, fadeState.transitionId]);

  // Removing the outgoing Plot at the same duration as the CSS fade leaves
  // one real Plot in steady state. Cleanup cancels stale completions on every
  // rapid retarget and on unmount.
  useEffect(() => {
    if (!enabled || fadeState.phase !== "fading") return;
    const transitionId = fadeState.transitionId;
    const timer = window.setTimeout(() => {
      dispatchFade({ type: "finish", transitionId });
    }, CROSS_FADE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fadeState.phase, fadeState.transitionId]);

  const crossFadeData = useMemo<CrossFadePlot[] | null>(() => {
    if (!enabled) return null;
    // `series` drives `baseLayout` and is retained as an explicit memo input
    // so timestamp/window changes cannot reuse a stale pair of Plot props.
    void series;
    const activePlot = buildCrossFadePlot({
      hiddenKeys: fadeState.activeHiddenKeys,
      currentBreakdown,
      baseLayout,
      active: true,
    });
    if (!fadeState.secondaryHiddenKeys) return [activePlot];

    const secondaryPlot = buildCrossFadePlot({
      hiddenKeys: fadeState.secondaryHiddenKeys,
      currentBreakdown,
      baseLayout,
      active: false,
    });
    // A removed/reordered breakdown can collapse distinct stable-key sets to
    // the same effective index combo. Never mount the duplicate Plot.
    if (secondaryPlot.key === activePlot.key) return [activePlot];

    // Keep keyed layers in a stable DOM order while `active` swaps between
    // them. Moving a Plot node during its opacity transition can make Plotly
    // recalculate its SVG even though z-index already owns the visual order.
    return activePlot.key < secondaryPlot.key
      ? [activePlot, secondaryPlot]
      : [secondaryPlot, activePlot];
  }, [
    enabled,
    series,
    currentBreakdown,
    baseLayout,
    fadeState.activeHiddenKeys,
    fadeState.secondaryHiddenKeys,
  ]);

  // Returns false to suppress Plotly's native legend toggle so visibility
  // flows through React state (which drives the cross-fade).
  const handleLegendClick = useCallback(
    (e: { readonly curveNumber: number }): boolean => {
      const clickedSeries = currentBreakdown[e.curveNumber];
      const seriesKey = clickedSeries
        ? breakdownVisibilityKey(clickedSeries)
        : null;
      if (seriesKey === null) return false;
      dispatchFade({
        type: "toggle",
        seriesKey,
        reduceMotion:
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      return false;
    },
    [currentBreakdown],
  );

  return { handleLegendClick, crossFadeData };
}

export function breakdownVisibilityKey(series: BreakdownSeries): string {
  return series.id ?? `${series.color}-${series.name}`;
}

export function hiddenSeriesKeysToIndexes(
  breakdown: ReadonlyArray<BreakdownSeries>,
  hiddenKeys: ReadonlySet<string>,
): Set<number> {
  const hiddenIdx = new Set<number>();
  breakdown.forEach((series, index) => {
    if (hiddenKeys.has(breakdownVisibilityKey(series))) {
      hiddenIdx.add(index);
    }
  });
  return hiddenIdx;
}

function setEquals<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
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

  // Payload normalization intentionally guards malformed Plotly event fields;
  // keep the existing complexity waiver local instead of line-number baselined.
  const onHover = useCallback(
    (e: {
      points?: unknown[];
      event?: { clientX?: number; clientY?: number };
      // eslint-disable-next-line complexity -- Plotly events are untrusted optional-field payloads.
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
      const sorted = sortedCopy(points, (a, b) => b.value - a.value);
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
