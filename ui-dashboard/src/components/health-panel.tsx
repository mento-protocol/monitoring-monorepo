"use client";

import type { Pool } from "@/lib/types";
import { HealthBadge } from "@/components/badges";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";
import { useNetwork } from "@/components/network-provider";

interface HealthPanelProps {
  pool: Pool;
}

/**
 * Exception-only panel — the pool header owns the primary health surface
 * (DeviationCell, Rebalance Status cell, metric grid). Rebalance diagnostics
 * moved into the Rebalance Status cell's tooltip, so this panel only stays
 * mounted for environmental states the header can't express: virtual pool,
 * missing health data, or the weekend pause. Otherwise it returns null.
 */
export function HealthPanel({ pool }: HealthPanelProps) {
  const { network } = useNetwork();
  const isVirtual = pool.source?.includes("virtual");
  // Trust only `hasHealthData === true` — `pool.healthStatus` is always
  // populated now (indexer's DEFAULT_ORACLE_FIELDS sets it to "N/A" even
  // for no-data pools), so a `!== undefined` check would silently hide
  // the "not yet available" fallback message this panel is meant to show.
  const hasHealthData = pool.hasHealthData === true;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleIsFresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const weekendPause = !oracleIsFresh && isWeekend();

  const hasContent = isVirtual || !hasHealthData || weekendPause;
  if (!hasContent) return null;

  // For the no-data branch, skip computeHealthStatus — with the indexer's
  // zero-initialised fields it would return CRITICAL from the stale
  // timestamp, contradicting the "not yet available" copy below. Show
  // N/A instead, which matches the virtual-pool branch visually.
  const badgeStatus =
    isVirtual || !hasHealthData
      ? "N/A"
      : computeHealthStatus(pool, network.chainId);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">Health Status</h2>
        <HealthBadge status={badgeStatus} />
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
        <div className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm text-slate-300">
          <span
            className="text-base leading-5 flex-shrink-0"
            aria-hidden="true"
          >
            🌙
          </span>
          <span>
            <span className="font-medium text-slate-200">
              Trading is paused for the weekend.
            </span>{" "}
            FX markets are closed and no fresh oracle data is available. Pool
            trading will resume automatically when markets reopen (~Sunday 23:00
            UTC).
          </span>
        </div>
      )}
    </div>
  );
}
