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
