"use client";

import { useRef, useState } from "react";

// Viewport state for the oracle chart: the user's zoom window (`visibleRange`,
// unix seconds, null = default/unset) and whether they asked for the full extent
// (`showAll` — Plotly "All" / double-click autorange). Both reset when the chart
// identity (`uirevision` = `${networkId}:${poolId}`) changes — done DURING render
// (not in an effect) so the first paint of a new pool never scopes to the old
// pool's window. (react-doctor accepts adjust-state-on-prop-change via a ref
// guard; an effect here would wipe a freshly-merged window on mount.)
export function useOracleViewport(uirevision: string | undefined): {
  visibleRange: [number, number] | null;
  setVisibleRange: (range: [number, number] | null) => void;
  showAll: boolean;
  setShowAll: (showAll: boolean) => void;
} {
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(
    null,
  );
  const [showAll, setShowAll] = useState(false);
  const prevUirevisionRef = useRef(uirevision);
  if (prevUirevisionRef.current !== uirevision) {
    prevUirevisionRef.current = uirevision;
    setVisibleRange(null);
    setShowAll(false);
  }
  return { visibleRange, setVisibleRange, showAll, setShowAll };
}

// One-shot gate for the chart's initial X range: `true` only on the first
// painted render for a given chart identity (`uirevision`), `false` on every
// later render — and re-armed when `uirevision` changes (pool switch) or while
// the chart isn't painting (`ready === false`, the zero-snapshot loading/blip
// state, so a remount re-applies the default view). The chart supplies an
// explicit `xaxis.range` only on that first paint, then omits it so uirevision
// preserves the user's viewport across SWR repolls. Without this, the
// re-supplied data-derived range clobbers a scroll-wheel zoom on the next data
// load (the wheel's programmatic relayout isn't a uirevision-tracked edit),
// snapping the view back out.
export function useInitialRangeGate(
  uirevision: string | undefined,
  ready: boolean,
): boolean {
  const ref = useRef<{ uirev: string | undefined; done: boolean }>({
    uirev: uirevision,
    done: false,
  });
  if (ref.current.uirev !== uirevision) {
    ref.current = { uirev: uirevision, done: false };
  }
  if (!ready) {
    ref.current.done = false; // not painting — arm for the next paint
    return false;
  }
  const apply = !ref.current.done;
  ref.current.done = true;
  return apply;
}
