"use client";

import type { Pool } from "@/lib/types";
import { useHealthScore } from "@/hooks/use-health-score";
import { formatBinaryHealthPct } from "@/lib/pool-health-score";

const HEALTH_SCORE_EXPLAINER =
  "Fraction of tracked time the oracle was both fresh (within expiry) and on-price (below the rebalance threshold). 7d is a rolling window; all-time aggregates since pool creation. Time before the first snapshot is excluded so new pools aren't penalised.";

export function HealthScoreValue({ pool }: { pool: Pool }) {
  const { healthWindow, allTimeScore, error } = useHealthScore(pool);

  // allTimeScore is derived from the Pool row directly, not the window GQL
  // queries, so a transient query failure should degrade only the 7d line.
  if (error && allTimeScore == null) {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-400">
        Query failed
        <HealthScoreInfoIcon />
      </span>
    );
  }
  if (!error && healthWindow.score == null && allTimeScore == null) {
    return (
      <span className="flex items-center gap-1 text-slate-500">
        N/A
        <HealthScoreInfoIcon />
      </span>
    );
  }

  const windowLabel = error
    ? "Query failed"
    : healthWindow.score == null
      ? "N/A"
      : formatBinaryHealthPct(healthWindow.score);
  const windowColor = error ? "text-amber-400" : "text-white";

  return (
    <span className="flex flex-col gap-0.5">
      <span className={`flex items-center gap-1 font-medium ${windowColor}`}>
        {windowLabel}
        <span className="text-xs text-slate-500">7d</span>
        <HealthScoreInfoIcon />
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

function HealthScoreInfoIcon() {
  return (
    <span
      role="img"
      aria-label="About the Health Score"
      title={HEALTH_SCORE_EXPLAINER}
      className="cursor-help text-xs text-slate-500 hover:text-slate-300"
    >
      ⓘ
    </span>
  );
}
