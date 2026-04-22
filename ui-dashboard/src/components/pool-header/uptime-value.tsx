"use client";

import type { Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import { POOL_BREACH_ROLLUP } from "@/lib/queries";
import { DEVIATION_BREACH_GRACE_SECONDS } from "@/lib/health";

const UPTIME_EXPLAINER =
  "% of tracked time the pool was NOT in a critical state. A pool flips to critical only after staying above its rebalance threshold for more than one hour — so a short breach that gets rebalanced promptly counts as uptime. Weekends when FX oracles are paused are excluded from both numerator and denominator.";

type BreachRollup = {
  cumulativeCriticalSeconds?: string;
  breachCount?: number;
};

/**
 * Uptime % = 1 − (cumulativeCriticalSeconds + open-breach live post-grace)
 *           / healthTotalSeconds
 *
 * Pulls the pool-level rollup via its own query so the number stays
 * accurate past the 100-row breach history cap. The live open-breach
 * portion is approximated against wall-clock — weekend subtraction
 * resolves exactly once the breach closes and the accumulator lands.
 */
export function UptimeValue({ pool }: { pool: Pool }) {
  const { data, error } = useGQL<{ Pool: BreachRollup[] }>(
    pool.source?.includes("virtual") ? null : POOL_BREACH_ROLLUP,
    { id: pool.id, chainId: pool.chainId },
  );

  const total = Number(pool.healthTotalSeconds ?? "0");
  if (!Number.isFinite(total) || total <= 0) {
    return <span className="text-slate-500">N/A</span>;
  }
  // During the indexer-resync window the hosted Hasura will reject the new
  // columns. Surface N/A rather than "Query failed" — the SLO simply isn't
  // tellable yet from the UI's point of view.
  if (error) return <span className="text-slate-500">N/A</span>;

  const rollup = data?.Pool?.[0];
  const rolledCritical = Number(rollup?.cumulativeCriticalSeconds ?? "0");
  const breachCount = rollup?.breachCount ?? 0;

  // Open-breach live contribution: the indexer rolls criticalDurationSeconds
  // into the scalar only on close, so an active breach that's already past
  // the 1h grace is not yet in `rolledCritical`. Reach out via the
  // still-indexed `deviationBreachStartedAt` on Pool itself (already in
  // POOL_DETAIL_WITH_HEALTH) so the tile moves in real time.
  const openStart = Number(pool.deviationBreachStartedAt ?? "0");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const openCritical =
    openStart > 0
      ? Math.max(
          0,
          nowSeconds - openStart - Number(DEVIATION_BREACH_GRACE_SECONDS),
        )
      : 0;

  const pct = Math.max(
    0,
    Math.min(100, (1 - (rolledCritical + openCritical) / total) * 100),
  );
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-white">
        {pct.toFixed(3)}%
        <span className="ml-1 text-xs text-slate-500">all-time</span>
      </span>
      <span className="text-xs text-slate-500">
        {breachCount === 0
          ? "no breaches"
          : `${breachCount} ${breachCount === 1 ? "breach" : "breaches"}`}
      </span>
    </span>
  );
}

export function UptimeInfoIcon() {
  return (
    <InfoPopover
      label={`About Uptime. ${UPTIME_EXPLAINER}`}
      content={UPTIME_EXPLAINER}
    />
  );
}
