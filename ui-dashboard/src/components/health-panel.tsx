"use client";

import type { Pool } from "@/lib/types";
import { HealthBadge } from "@/components/badges";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";
import { useNetwork } from "@/components/network-provider";
import { useRebalanceCheck } from "@/hooks/use-rebalance-check";
import type { RebalanceCheckResult } from "@/lib/rebalance-check";

interface HealthPanelProps {
  pool: Pool;
}

/**
 * Exception-only panel — the pool header owns the primary health surface
 * (DeviationRow + metric cells). This panel stays mounted only when it has
 * something the header doesn't already show: a virtual-pool notice, missing
 * health-data notice, the weekend pause copy, or a rebalance diagnostics
 * bundle. Otherwise it returns null and gets out of the way.
 */
export function HealthPanel({ pool }: HealthPanelProps) {
  const { network } = useNetwork();
  const isVirtual = pool.source?.includes("virtual");
  const hasHealthData =
    pool.hasHealthData === true || pool.healthStatus !== undefined;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleIsFresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const weekendPause = !oracleIsFresh && isWeekend();

  const { data: rebalanceCheck, error: rebalanceCheckError } =
    useRebalanceCheck(pool, network);

  // Show diagnostics when they carry info the top-row status cells don't:
  // a blocked revert with a decoded message, a CDP/Reserve enrichment bundle,
  // or a transport-level error.
  const showRebalanceDiag =
    !isVirtual &&
    hasHealthData &&
    !weekendPause &&
    (!!rebalanceCheckError ||
      (rebalanceCheck !== null &&
        (!rebalanceCheck.canRebalance || rebalanceCheck.enrichment !== null)));

  const hasContent =
    isVirtual || !hasHealthData || weekendPause || showRebalanceDiag;
  if (!hasContent) return null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">Health Status</h2>
        <HealthBadge status={computeHealthStatus(pool, network.chainId)} />
      </div>

      {isVirtual ? (
        <p className="text-sm text-slate-400">
          VirtualPool — no oracle data. Health monitoring is not applicable.
        </p>
      ) : !hasHealthData ? (
        <p className="text-sm text-slate-400">
          Oracle health data not yet available — indexer schema update pending.
        </p>
      ) : weekendPause ? (
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
      ) : (
        <RebalanceDiagnostics
          result={rebalanceCheck}
          error={rebalanceCheckError}
        />
      )}
    </div>
  );
}

function RebalanceDiagnostics({
  result,
  error,
}: {
  result: RebalanceCheckResult | null;
  error: Error | undefined;
}) {
  if (error) {
    return (
      <div>
        <h3 className="text-sm font-medium text-slate-400 mb-3">
          Rebalance Details
        </h3>
        <p className="text-sm text-slate-300 leading-relaxed">
          Diagnostics unavailable
          <span
            className="ml-1.5 text-xs text-slate-600 border-b border-dotted border-slate-600"
            role="note"
            aria-label={`Raw error: ${error.message}`}
          >
            [{error.message.slice(0, 120)}]
          </span>
        </p>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="lg:w-72 lg:flex-shrink-0 lg:border-l lg:border-slate-800 lg:pl-6">
      <h3 className="text-sm font-medium text-slate-400 mb-3">
        Rebalance Details
      </h3>

      <div className="flex flex-col gap-3">
        {!result.canRebalance && (
          <p className="text-sm text-slate-300 leading-relaxed">
            {result.message}
            {result.rawError && (
              <span
                className="ml-1.5 text-xs text-slate-600 border-b border-dotted border-slate-600"
                role="note"
                aria-label={`Raw error: ${result.rawError}`}
              >
                [{result.rawError}]
              </span>
            )}
          </p>
        )}

        {result.enrichment && (
          <EnrichmentDetail enrichment={result.enrichment} />
        )}
      </div>
    </div>
  );
}

function EnrichmentDetail({
  enrichment,
}: {
  enrichment: NonNullable<RebalanceCheckResult["enrichment"]>;
}) {
  if (enrichment.type === "cdp") {
    const balance = enrichment.stabilityPoolBalance;
    const formatted =
      balance >= 1000 ? `${(balance / 1000).toFixed(1)}k` : balance.toFixed(2);

    return (
      <div className="rounded border border-slate-700/50 bg-slate-800/50 px-3 py-2">
        <div className="text-xs text-slate-400 mb-1">
          Stability Pool Balance
        </div>
        <div className="text-sm font-mono text-slate-200">
          {formatted} {enrichment.stabilityPoolTokenSymbol}
        </div>
      </div>
    );
  }

  if (enrichment.type === "reserve") {
    const balance = enrichment.reserveCollateralBalance;
    const formatted =
      balance >= 1000 ? `${(balance / 1000).toFixed(1)}k` : balance.toFixed(2);

    return (
      <div className="rounded border border-slate-700/50 bg-slate-800/50 px-3 py-2">
        <div className="text-xs text-slate-400 mb-1">
          Reserve Collateral Balance
        </div>
        <div className="text-sm font-mono text-slate-200">
          {formatted} {enrichment.collateralTokenSymbol}
        </div>
      </div>
    );
  }

  return null;
}
