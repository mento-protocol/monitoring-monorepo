"use client";

import type { Pool } from "@/lib/types";
import { useHealthScore } from "@/hooks/use-health-score";
import { formatBinaryHealthPct } from "@/lib/pool-health-score";
import { InfoPopover } from "@/components/info-popover";
import { isFxPool } from "@/lib/tokens";
import { useNetwork } from "@/components/network-provider";

const HEALTH_SCORE_EXPLAINER =
  "% of time the oracle rate was fresh and price deviation was within threshold";
const HEALTH_SCORE_FX_SUFFIX =
  " (excluding weekends, because there are no oracle updates outside of tradfi market hours)";

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

/** Under 24h show as hours ("5.3h") so nobody reads "0.2d"; otherwise days. */
function formatObservedDuration(observedHours: number): string {
  if (observedHours < 24) return `${observedHours.toFixed(1)}h`;
  return `${(observedHours / 24).toFixed(1)}d`;
}

/** FX pools append a weekend caveat — their oracle pauses when TradFi markets close, so without it the score mechanically decays every weekend. */
export function HealthScoreInfoIcon({ pool }: { pool: Pool }) {
  const { network } = useNetwork();
  const suffix = isFxPool(network, pool.token0, pool.token1)
    ? HEALTH_SCORE_FX_SUFFIX
    : "";
  const content = HEALTH_SCORE_EXPLAINER + suffix;
  return (
    <InfoPopover
      label={`About the Health Score. ${content}`}
      content={content}
    />
  );
}
