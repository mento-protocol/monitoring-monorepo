"use client";

import type { Pool } from "@/lib/types";
import { useHealthScore } from "@/hooks/use-health-score";
import { formatBinaryHealthPct } from "@/lib/pool-health-score";
import { InfoPopover } from "@/components/info-popover";

const HEALTH_SCORE_EXPLAINER =
  "% of time the pool was healthy — oracle rate fresh AND price deviation within threshold.";

export function HealthScoreValue({ pool }: { pool: Pool }) {
  const { healthWindow, allTimeScore, truncated, nominalWindowSeconds, error } =
    useHealthScore(pool);

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

  // Show the nominal window ("7d") only when coverage actually reached it.
  // Otherwise degrade honestly to the observed duration ("5.3d") so the
  // label can't overstate how much data the score is based on — the
  // snapshot cap or a young pool can both produce sub-window coverage.
  // On error we omit the period label entirely: `observedHours` will be
  // 0 from the empty window, and "Query failed 0.0h" is nonsense.
  const fullyCovered =
    !truncated && healthWindow.trackedSeconds >= nominalWindowSeconds;
  const periodLabel = error
    ? null
    : fullyCovered
      ? `${Math.round(nominalWindowSeconds / 86400)}d`
      : formatObservedDuration(healthWindow.observedHours);

  return (
    <span className="flex flex-col gap-0.5">
      <span className={`font-medium ${windowColor}`}>
        {windowLabel}
        {periodLabel && (
          <span className="ml-1 text-xs text-slate-500">{periodLabel}</span>
        )}
      </span>
      {allTimeScore != null && (
        <span className="text-xs text-slate-500">
          {formatBinaryHealthPct(allTimeScore)} all-time
        </span>
      )}
    </span>
  );
}

/**
 * Format observed duration as the most meaningful unit: hours under 24h
 * (so nobody reads "0.2d"), days otherwise. Matches the existing "Nh
 * observed" pattern but promotes to days for longer spans.
 */
function formatObservedDuration(observedHours: number): string {
  if (observedHours < 24) return `${observedHours.toFixed(1)}h`;
  return `${(observedHours / 24).toFixed(1)}d`;
}

/**
 * Info icon for the Health Score header label. Rendered in the cell's
 * `<dt>` so the explainer reads as "about this metric" rather than
 * hanging off the 7d value. Click / Enter / Space opens the explainer
 * so keyboard users get the same access as mouse hover.
 */
export function HealthScoreInfoIcon() {
  return (
    <InfoPopover
      label={`About the Health Score. ${HEALTH_SCORE_EXPLAINER}`}
      content={HEALTH_SCORE_EXPLAINER}
    />
  );
}
