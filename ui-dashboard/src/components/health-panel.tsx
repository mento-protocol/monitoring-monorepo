"use client";

import { isVirtualPool, type Pool } from "@/lib/types";
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
 * missing health data, the weekend pause, or a price-breaker halt. Otherwise
 * it returns null.
 */
export function HealthPanel({ pool }: HealthPanelProps) {
  const { network } = useNetwork();
  const isVirtual = isVirtualPool(pool);
  // Trust only `hasHealthData === true` — `pool.healthStatus` is always
  // populated now (indexer's DEFAULT_ORACLE_FIELDS sets it to "N/A" even
  // for no-data pools), so a `!== undefined` check would silently hide
  // the "not yet available" fallback message this panel is meant to show.
  const hasHealthData = pool.hasHealthData === true;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleIsFresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const weekendPause = !oracleIsFresh && isWeekend();

  // For the no-data branch, skip computeHealthStatus — with the indexer's
  // zero-initialised fields it would return CRITICAL from the stale
  // timestamp, contradicting the "not yet available" copy below. Show
  // N/A instead, which matches the virtual-pool branch visually.
  const badgeStatus =
    isVirtual || !hasHealthData
      ? "N/A"
      : computeHealthStatus(pool, network.chainId);
  // A tripped price breaker (fresh oracle) resolves to HALTED — surface it as
  // its own exception state so the detail page stops reading "healthy" while
  // swaps are paused. Keying on the resolved status (not the raw flag) keeps it
  // consistent with the fleet chip: stale / weekend pools resolve to
  // CRITICAL / WEEKEND and fall through to those branches / the header instead.
  const showHalted = badgeStatus === "HALTED";

  const hasContent = isVirtual || !hasHealthData || weekendPause || showHalted;
  if (!hasContent) return null;

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
      ) : showHalted ? (
        <div className="flex items-start gap-3 rounded-lg border border-orange-700/50 bg-orange-900/20 px-4 py-3 text-sm text-orange-100">
          <span
            className="text-base leading-5 flex-shrink-0"
            aria-hidden="true"
          >
            🛑
          </span>
          <span>
            <span className="font-medium text-orange-200">
              Trading is halted.
            </span>{" "}
            A price circuit breaker is tripped for this rate feed, so swaps are
            paused until it resets — see the breaker panel below for the live
            threshold and cooldown.
          </span>
        </div>
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
