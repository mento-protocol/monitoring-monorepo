"use client";

import type { Pool } from "@/lib/types";
import { useHealthScore } from "@/hooks/use-health-score";
import { formatBinaryHealthPct, formatNines } from "@/lib/pool-health-score";

export function HealthScoreValue({ pool }: { pool: Pool }) {
  const { health24h, allTimeScore, error } = useHealthScore(pool);

  if (error) {
    return <span className="text-xs text-amber-400">Query failed</span>;
  }
  if (health24h.score == null && allTimeScore == null) {
    return <span className="text-slate-500">N/A</span>;
  }

  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-white">
        {health24h.score == null
          ? "N/A"
          : formatBinaryHealthPct(health24h.score)}
        <span className="ml-1 text-xs text-slate-500">24h</span>
      </span>
      {allTimeScore != null && (
        <span className="text-xs text-slate-500">
          {formatBinaryHealthPct(allTimeScore)} all-time ·{" "}
          {formatNines(allTimeScore)}
        </span>
      )}
      {health24h.score != null && !health24h.hasEnoughDataForNines && (
        <span className="text-xs text-slate-600">
          {health24h.observedHours.toFixed(1)}h observed
        </span>
      )}
    </span>
  );
}
