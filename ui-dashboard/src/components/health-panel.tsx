"use client";

import type { Pool } from "@/lib/types";
import { HealthBadge } from "@/components/badges";
import { tokenSymbol } from "@/lib/tokens";
import { relativeTime, formatTimestamp, SORTED_ORACLES_DECIMALS } from "@/lib/format";
import { useNetwork } from "@/components/network-provider";

/** SortedOracles always uses 24-decimal precision (denominator = 10^24). */
function parseOraclePrice(num: string): string {
  if (!num || num === "0") return "—";
  const price = Number(num) / 10 ** SORTED_ORACLES_DECIMALS;
  if (!isFinite(price) || price <= 0) return "—";
  return price.toFixed(6);
}

interface DeviationBarProps {
  priceDifference: string;
  rebalanceThreshold: number;
}

function DeviationBar({
  priceDifference,
  rebalanceThreshold,
}: DeviationBarProps) {
  if (!rebalanceThreshold || rebalanceThreshold === 0) {
    return <span className="text-slate-400 text-sm">—</span>;
  }
  const diff = Number(priceDifference);
  const threshold = rebalanceThreshold;
  const ratio = Math.min(diff / threshold, 1.5); // cap at 150%
  const pct = Math.min(ratio * 100, 100);
  const color =
    ratio >= 1.0
      ? "bg-red-500"
      : ratio >= 0.8
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-slate-200">
        {diff.toLocaleString()} bps / {threshold.toLocaleString()} bps threshold
      </span>
      <div className="h-2 w-full rounded-full bg-slate-700">
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

interface HealthPanelProps {
  pool: Pool;
}

export function HealthPanel({ pool }: HealthPanelProps) {
  const { network } = useNetwork();
  const isVirtual = pool.source?.includes("virtual");
  const hasHealthData = pool.healthStatus !== undefined;

  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  const oraclePrice = parseOraclePrice(pool.oraclePrice ?? "0");

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">Health Status</h2>
        <HealthBadge status={pool.healthStatus ?? "N/A"} />
      </div>

      {isVirtual ? (
        <p className="text-sm text-slate-400">
          VirtualPool — no oracle data. Health monitoring is not applicable.
        </p>
      ) : !hasHealthData ? (
        <p className="text-sm text-slate-400">
          Oracle health data not yet available — indexer schema update pending.
        </p>
      ) : (
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
          {/* Oracle Status */}
          <div>
            <dt className="text-slate-400 mb-1">Oracle Status</dt>
            <dd className="flex flex-col gap-0.5">
              <span
                className={pool.oracleOk ? "text-emerald-400" : "text-red-400"}
              >
                {pool.oracleOk ? "✓ Fresh" : "✗ Stale"}
              </span>
              {pool.oracleTimestamp && pool.oracleTimestamp !== "0" && (
                <span
                  className="text-xs text-slate-400"
                  title={formatTimestamp(pool.oracleTimestamp)}
                >
                  Last updated {relativeTime(pool.oracleTimestamp)}
                </span>
              )}
            </dd>
          </div>

          {/* Oracle Price */}
          <div>
            <dt className="text-slate-400 mb-1">Oracle Price</dt>
            <dd className="text-white font-mono">
              {oraclePrice !== "—" ? (
                <span>
                  1 {sym0} = {oraclePrice} {sym1}
                </span>
              ) : (
                <span className="text-slate-500">—</span>
              )}
            </dd>
          </div>

          {/* Reporters */}
          <div>
            <dt className="text-slate-400 mb-1">Oracle Reporters</dt>
            <dd className="text-white">
              {pool.oracleNumReporters != null &&
              pool.oracleNumReporters > 0 ? (
                pool.oracleNumReporters
              ) : (
                <span className="text-slate-500">—</span>
              )}
            </dd>
          </div>

          {/* Deviation */}
          <div className="sm:col-span-2">
            <dt className="text-slate-400 mb-1">Deviation vs Threshold</dt>
            <dd>
              <DeviationBar
                priceDifference={pool.priceDifference ?? "0"}
                rebalanceThreshold={pool.rebalanceThreshold ?? 0}
              />
            </dd>
          </div>

          {/* Last Rebalance */}
          <div>
            <dt className="text-slate-400 mb-1">Last Rebalance</dt>
            <dd
              className="text-white"
              title={
                pool.lastRebalancedAt && pool.lastRebalancedAt !== "0"
                  ? formatTimestamp(pool.lastRebalancedAt)
                  : undefined
              }
            >
              {pool.lastRebalancedAt && pool.lastRebalancedAt !== "0" ? (
                relativeTime(pool.lastRebalancedAt)
              ) : (
                <span className="text-slate-500">Never</span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
