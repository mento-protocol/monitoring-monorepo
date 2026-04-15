"use client";

import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { HealthBadge } from "@/components/badges";
import type { HealthStatus } from "@/lib/health";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";

/**
 * "Deviation" cell for the pool header's metric row. Carries the
 * HealthBadge inline with its label and a compact progress bar sized to
 * the cell, sitting alongside the other metric cells instead of stretching
 * across the full width of the box.
 *
 * Returns null for cases where HealthPanel below still has a clearer
 * story to tell (virtual, pre-migration data, weekend pause).
 */
export function DeviationCell({
  pool,
  network,
}: {
  pool: Pool;
  network: Network;
}) {
  const isVirtual = pool.source?.includes("virtual");
  const hasHealthData =
    pool.hasHealthData === true || pool.healthStatus !== undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleIsFresh = isOracleFresh(pool, nowSeconds, network.chainId);

  if (isVirtual) return null;
  if (!hasHealthData) return null;
  if (!oracleIsFresh && isWeekend()) return null;

  const status = computeHealthStatus(pool, network.chainId);

  return (
    <div className="min-w-56">
      <dt className="flex items-center gap-2 text-slate-400">
        Deviation
        <HealthBadge status={status} />
      </dt>
      <dd className="mt-1">
        <DeviationBar
          priceDifference={pool.priceDifference ?? "0"}
          rebalanceThreshold={pool.rebalanceThreshold ?? 0}
          status={status}
        />
      </dd>
    </div>
  );
}

function DeviationBar({
  priceDifference,
  rebalanceThreshold,
  status,
}: {
  priceDifference: string;
  rebalanceThreshold: number;
  status: HealthStatus;
}) {
  const diff = Number(priceDifference);
  if (!rebalanceThreshold || rebalanceThreshold === 0 || diff === 0) {
    return <span className="text-sm text-slate-400">—</span>;
  }
  const threshold = rebalanceThreshold;
  const ratio = Math.min(diff / threshold, 1.5);
  const pct = Math.min(ratio * 100, 100);
  // Source the bar color from computeHealthStatus instead of recomputing
  // from the raw ratio, so the bar and the HealthBadge always agree on
  // severity — including at the exact-threshold boundary (WARN, not
  // CRITICAL) and during the 1h rebalance grace window.
  const color =
    status === "CRITICAL"
      ? "bg-red-500"
      : status === "WARN"
        ? "bg-amber-500"
        : "bg-emerald-500";

  // Raw deviation / threshold are stored in basis points (10000 bps = 100%),
  // but humans reason about this in percentages. Convert before rendering
  // so the parenthetical reads `(49.97% / 50.00%)` instead of the opaque
  // `(4997 / 5000 bps)` that the indexer emits.
  const diffPct = (diff / 100).toFixed(2);
  const thresholdPct = (threshold / 100).toFixed(2);

  // Frame the primary number as a signed delta from the threshold so the
  // alarm direction reads directly: "52.1% above threshold" instead of
  // "152.1% of threshold" (which requires mental math to extract the
  // overage). The `ratio > 1` branch means breached, `< 1` means safely
  // under, `=== 1` is handled by the Rebalance Status cell's "At
  // threshold" label and won't reach this bar.
  const deltaPct = (Math.abs(diff - threshold) / threshold) * 100;
  const deltaLabel =
    diff > threshold
      ? `${deltaPct.toFixed(1)}% above threshold`
      : `${deltaPct.toFixed(1)}% below threshold`;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-slate-200">
        {deltaLabel}
        <span className="ml-1.5 text-xs text-slate-500">
          ({diffPct}% / {thresholdPct}%)
        </span>
      </span>
      <div className="h-2 w-56 rounded-full bg-slate-700">
        <div
          className={`h-2 rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={diff}
          aria-valuemax={threshold}
        />
      </div>
    </div>
  );
}
