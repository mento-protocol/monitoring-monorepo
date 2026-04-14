"use client";

import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { HealthBadge } from "@/components/badges";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";

/**
 * "Deviation vs Threshold" cell for the pool header's metric row. Carries
 * the HealthBadge inline with its label and a compact progress bar sized
 * to the cell, sitting alongside the other metric cells instead of
 * stretching across the full width of the box.
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
        Deviation vs Threshold
        <HealthBadge status={status} />
      </dt>
      <dd className="mt-1">
        <DeviationBar
          priceDifference={pool.priceDifference ?? "0"}
          rebalanceThreshold={pool.rebalanceThreshold ?? 0}
        />
      </dd>
    </div>
  );
}

function DeviationBar({
  priceDifference,
  rebalanceThreshold,
}: {
  priceDifference: string;
  rebalanceThreshold: number;
}) {
  const diff = Number(priceDifference);
  if (!rebalanceThreshold || rebalanceThreshold === 0 || diff === 0) {
    return <span className="text-sm text-slate-400">—</span>;
  }
  const threshold = rebalanceThreshold;
  const ratio = Math.min(diff / threshold, 1.5);
  const pct = Math.min(ratio * 100, 100);
  const pctOfThreshold = ((diff / threshold) * 100).toFixed(1);
  const color =
    ratio >= 1.0
      ? "bg-red-500"
      : ratio >= 0.8
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-slate-200">
        {pctOfThreshold}% of threshold
        <span className="ml-1.5 text-xs text-slate-500">
          ({diff.toLocaleString()} / {threshold.toLocaleString()} bps)
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
