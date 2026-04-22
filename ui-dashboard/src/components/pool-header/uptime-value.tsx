"use client";

import type { Pool } from "@/lib/types";
import { InfoPopover } from "@/components/info-popover";
import { useGQL } from "@/lib/graphql";
import { POOL_BREACH_ROLLUP } from "@/lib/queries";
import { DEVIATION_BREACH_GRACE_SECONDS } from "@/lib/health";
import { tradingSecondsInRange } from "@/lib/weekend";

const UPTIME_EXPLAINER =
  "% of tracked time the pool was NOT in a critical state. A pool flips to critical only after staying above its rebalance threshold for more than one hour — so a short breach that gets rebalanced promptly counts as uptime. Weekends when FX oracles are paused are excluded from both numerator and denominator.";

type BreachRollup = {
  cumulativeCriticalSeconds?: string;
  breachCount?: number;
  deviationBreachStartedAt?: string;
};

export function UptimeValue({ pool }: { pool: Pool }) {
  const { data, error } = useGQL<{ Pool: BreachRollup[] }>(
    pool.source.includes("virtual") ? null : POOL_BREACH_ROLLUP,
    { id: pool.id, chainId: pool.chainId },
  );

  const total = Number(pool.healthTotalSeconds ?? "0");
  if (!Number.isFinite(total) || total <= 0) {
    return <span className="text-slate-500">N/A</span>;
  }
  // During the indexer-resync window the hosted Hasura rejects the new
  // columns. N/A is the honest answer for "can't tell yet" — surfacing
  // "Query failed" would cry wolf.
  if (error) return <span className="text-slate-500">N/A</span>;

  // Read rollup + open-breach anchor from the SAME query result so they're
  // a consistent snapshot. Mixing with `pool.deviationBreachStartedAt`
  // from POOL_DETAIL_WITH_HEALTH would double-count a just-closed breach
  // during the brief window where the rollup refreshed first.
  const rollup = data?.Pool?.[0];
  const rolledCritical = Number(rollup?.cumulativeCriticalSeconds ?? "0");
  const closedBreachCount = rollup?.breachCount ?? 0;
  const openStart = Number(rollup?.deviationBreachStartedAt ?? "0");
  const hasOpenBreach = openStart > 0;

  // Open breaches aren't in `rolledCritical` until they close — add the
  // live past-grace portion so the tile moves in real time. Uses
  // `tradingSecondsInRange` (same weekend subtraction the indexer uses to
  // compute `healthTotalSeconds`) so the numerator and denominator are on
  // the same basis — a breach that spans a weekend doesn't get credited
  // seconds the denominator never saw.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const graceEnd = openStart + Number(DEVIATION_BREACH_GRACE_SECONDS);
  const openCritical =
    hasOpenBreach && nowSeconds > graceEnd
      ? tradingSecondsInRange(graceEnd, nowSeconds)
      : 0;

  const pct = Math.max(
    0,
    Math.min(100, (1 - (rolledCritical + openCritical) / total) * 100),
  );
  const totalBreaches = closedBreachCount + (hasOpenBreach ? 1 : 0);
  const subtitle =
    totalBreaches === 0
      ? "no breaches"
      : hasOpenBreach && closedBreachCount === 0
        ? "1 ongoing breach"
        : hasOpenBreach
          ? `${closedBreachCount} past + 1 ongoing`
          : `${closedBreachCount} ${closedBreachCount === 1 ? "breach" : "breaches"}`;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-white">
        {pct.toFixed(3)}%
        <span className="ml-1 text-xs text-slate-500">all-time</span>
      </span>
      <span className="text-xs text-slate-500">{subtitle}</span>
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
