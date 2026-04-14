"use client";

import type { Pool } from "@/lib/types";
import { HealthBadge } from "@/components/badges";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";
import { useNetwork } from "@/components/network-provider";
import { useRebalanceCheck } from "@/hooks/use-rebalance-check";
import type { RebalanceCheckResult } from "@/lib/rebalance-check";

interface DeviationBarProps {
  priceDifference: string;
  rebalanceThreshold: number;
}

function DeviationBar({
  priceDifference,
  rebalanceThreshold,
}: DeviationBarProps) {
  const diff = Number(priceDifference);
  if (!rebalanceThreshold || rebalanceThreshold === 0 || diff === 0) {
    return <span className="text-slate-400 text-sm">—</span>;
  }
  const threshold = rebalanceThreshold;
  const ratio = Math.min(diff / threshold, 1.5); // cap at 150%
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
        {pctOfThreshold}% of rebalance threshold
        <span className="ml-2 text-xs text-slate-500">
          ({diff.toLocaleString()} / {threshold.toLocaleString()} bps)
        </span>
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
  const hasHealthData =
    pool.hasHealthData === true || pool.healthStatus !== undefined;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleIsFresh = isOracleFresh(pool, nowSeconds, network.chainId);

  const { data: rebalanceCheck, error: rebalanceCheckError } =
    useRebalanceCheck(pool, network);

  // Only show the diagnostics panel when it carries info the top-row status
  // doesn't already convey: a blocked revert with a decoded message, an
  // enrichment bundle (CDP / Reserve balances), or a transport-level error.
  const showRebalanceDiag =
    !!rebalanceCheckError ||
    (rebalanceCheck !== null &&
      (!rebalanceCheck.canRebalance || rebalanceCheck.enrichment !== null));

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
      ) : !oracleIsFresh && isWeekend() ? (
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
        <div
          className={`flex flex-col ${showRebalanceDiag ? "lg:flex-row" : ""} gap-6`}
        >
          <dl
            className={showRebalanceDiag ? "lg:flex-1 lg:min-w-0" : "w-full"}
          >
            <div>
              <dt className="text-sm text-slate-400 mb-1">
                Deviation vs Threshold
              </dt>
              <dd>
                <DeviationBar
                  priceDifference={pool.priceDifference ?? "0"}
                  rebalanceThreshold={pool.rebalanceThreshold ?? 0}
                />
              </dd>
            </div>
          </dl>

          {showRebalanceDiag && (
            <RebalanceDiagnostics
              result={rebalanceCheck}
              error={rebalanceCheckError}
            />
          )}
        </div>
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
      <div className="lg:w-72 lg:flex-shrink-0 lg:border-l lg:border-slate-800 lg:pl-6">
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
