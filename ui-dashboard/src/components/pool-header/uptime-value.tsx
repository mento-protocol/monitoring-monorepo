"use client";

import type { Pool, DeviationThresholdBreach } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import { POOL_DEVIATION_BREACHES } from "@/lib/queries";

const UPTIME_EXPLAINER =
  "% of tracked time the pool was NOT in a critical state. A pool flips to critical only after staying above its rebalance threshold for more than one hour — so a short breach that gets rebalanced promptly counts as uptime. Weekends when FX oracles are paused are excluded from both numerator and denominator.";

const GRACE_SECONDS = 3600;

/**
 * Uptime % derived from the DeviationThresholdBreach history:
 *   uptime = 1 − Σ(criticalDurationSeconds) / healthTotalSeconds
 *
 * Fetching per-breach rows (rather than a pre-rolled scalar on the Pool
 * entity) keeps this feature self-contained during the indexer resync —
 * POOL_DETAIL_WITH_HEALTH doesn't gain any new fields, so the rest of the
 * pool page doesn't break while the new entity type is rolling out.
 *
 * The denominator (`pool.healthTotalSeconds`) is the same trading-seconds
 * accumulator the Health Score tile uses, so the two tiles share a basis.
 */
export function UptimeValue({ pool }: { pool: Pool }) {
  const { data, error } = useGQL<{
    DeviationThresholdBreach: DeviationThresholdBreach[];
  }>(pool.source?.includes("virtual") ? null : POOL_DEVIATION_BREACHES, {
    poolId: pool.id,
  });

  const total = Number(pool.healthTotalSeconds ?? "0");
  if (!Number.isFinite(total) || total <= 0) {
    return <span className="text-slate-500">N/A</span>;
  }

  // During the indexer-resync window the hosted Hasura will reject the new
  // entity type. Surface N/A rather than "Query failed" — the field simply
  // doesn't exist yet from the UI's point of view.
  if (error) return <span className="text-slate-500">N/A</span>;

  const breaches = data?.DeviationThresholdBreach ?? [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const critical = breaches.reduce((acc, b) => {
    if (b.endedAt != null) {
      return acc + Number(b.criticalDurationSeconds ?? "0");
    }
    // Open breach: count whatever portion of time has already passed the
    // 1h grace at the current wall-clock. Approximation — doesn't subtract
    // the weekend overlap the indexer would subtract at close time — but
    // good enough for the live tile, and resolves exactly once the breach
    // closes and the accumulated row lands.
    const age = nowSeconds - Number(b.startedAt);
    return acc + Math.max(0, age - GRACE_SECONDS);
  }, 0);

  const pct = Math.max(0, Math.min(100, (1 - critical / total) * 100));
  const breachCount = breaches.length;
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
