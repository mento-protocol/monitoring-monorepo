"use client";

import type { Pool } from "@/lib/types";
import { useHealthScore } from "@/hooks/use-health-score";
import { formatBinaryHealthPct } from "@/lib/pool-health-score";

const HEALTH_SCORE_EXPLAINER =
  "Fraction of tracked time the oracle was both fresh (within expiry) and on-price (below the rebalance threshold). 7d is a rolling window; all-time aggregates since pool creation.";

export function HealthScoreValue({ pool }: { pool: Pool }) {
  const { healthWindow, allTimeScore, error } = useHealthScore(pool);

  // allTimeScore is derived from the Pool row directly, not the window GQL
  // queries, so a transient query failure should degrade only the 7d line.
  if (error && allTimeScore == null) {
    return <span className="text-xs text-amber-400">Query failed</span>;
  }
  if (!error && healthWindow.score == null && allTimeScore == null) {
    return <span className="text-slate-500">N/A</span>;
  }

  const windowLabel = error
    ? "Query failed"
    : healthWindow.score == null
      ? "N/A"
      : formatBinaryHealthPct(healthWindow.score);
  const windowColor = error ? "text-amber-400" : "text-white";

  return (
    <span className="flex flex-col gap-0.5">
      <span className={`font-medium ${windowColor}`}>
        {windowLabel}
        <span className="ml-1 text-xs text-slate-500">7d</span>
      </span>
      {allTimeScore != null && (
        <span className="text-xs text-slate-500">
          {formatBinaryHealthPct(allTimeScore)} all-time
        </span>
      )}
      {!error &&
        healthWindow.score != null &&
        !healthWindow.hasEnoughDataForNines && (
          <span className="text-xs text-slate-600">
            {healthWindow.observedHours.toFixed(1)}h observed
          </span>
        )}
    </span>
  );
}

/**
 * Info icon for the Health Score header label. Rendered in the cell's
 * `<dt>` so the explainer reads as "about this metric" rather than
 * hanging off the 7d value. Native-title tooltip matches the rest of the
 * codebase's hover-help pattern.
 */
export function HealthScoreInfoIcon() {
  return (
    <button
      type="button"
      aria-label={`About the Health Score. ${HEALTH_SCORE_EXPLAINER}`}
      title={HEALTH_SCORE_EXPLAINER}
      className="cursor-help text-xs text-slate-500 hover:text-slate-300 focus:outline-none focus:ring-1 focus:ring-slate-500 focus:rounded"
    >
      ⓘ
    </button>
  );
}
