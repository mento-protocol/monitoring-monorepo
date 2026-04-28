"use client";

import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import type { HealthStatus } from "@/lib/health";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";
import { relativeTime, formatTimestamp } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { POOL_OPEN_BREACH_TX } from "@/lib/queries";
import { explorerTxUrl } from "@/lib/tokens";

export function DeviationCell({
  pool,
  network,
}: {
  pool: Pool;
  network: Network;
}) {
  const isVirtual = pool.source?.includes("virtual");
  // Trust only `hasHealthData === true` — the indexer's default values
  // populate `pool.healthStatus` with "N/A" even for no-data pools, so a
  // `!== undefined` disjunction would let this cell render a synthetic
  // deviation bar for rows the indexer explicitly marked as no-data.
  const hasHealthData = pool.hasHealthData === true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleIsFresh = isOracleFresh(pool, nowSeconds, network.chainId);

  const breachStartedAt =
    pool.deviationBreachStartedAt && pool.deviationBreachStartedAt !== "0"
      ? pool.deviationBreachStartedAt
      : null;

  // Look up the trip transaction so the "breach Xh ago" line can link to
  // the explorer. Skip the query when there's no open breach to avoid a
  // wasted round-trip on healthy pools.
  const { data: tripTxData } = useGQL<{
    DeviationThresholdBreach: { startedByTxHash?: string }[];
  }>(breachStartedAt ? POOL_OPEN_BREACH_TX : null, {
    poolId: pool.id,
    startedAt: breachStartedAt ?? "0",
  });
  const trippedByTxHash =
    tripTxData?.DeviationThresholdBreach?.[0]?.startedByTxHash ?? null;

  if (isVirtual) return null;
  if (!hasHealthData) return null;
  if (!oracleIsFresh && isWeekend()) return null;

  const status = computeHealthStatus(pool, network.chainId);

  return (
    <div>
      <dt className="text-slate-400">Deviation</dt>
      <dd>
        <DeviationBar
          priceDifference={pool.priceDifference ?? "0"}
          rebalanceThreshold={pool.rebalanceThreshold ?? 0}
          status={status}
          breachStartedAt={breachStartedAt}
          trippedByTxHash={trippedByTxHash}
          network={network}
        />
      </dd>
    </div>
  );
}

function DeviationBar({
  priceDifference,
  rebalanceThreshold,
  status,
  breachStartedAt,
  trippedByTxHash,
  network,
}: {
  priceDifference: string;
  rebalanceThreshold: number;
  status: HealthStatus;
  breachStartedAt: string | null;
  trippedByTxHash: string | null;
  network: Network;
}) {
  const diff = Number(priceDifference);
  if (!rebalanceThreshold || rebalanceThreshold === 0 || diff === 0) {
    // No usable threshold/diff to draw a bar against — but `health.ts`
    // falls back to a 10000-bps effective threshold, so an open breach
    // CAN still exist on this pool. Render the breach line so the alarm
    // survives the bar's no-data path.
    if (breachStartedAt) {
      return (
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-slate-400">—</span>
          <BreachLine
            breachStartedAt={breachStartedAt}
            status={status}
            trippedByTxHash={trippedByTxHash}
            network={network}
          />
        </div>
      );
    }
    return <span className="text-sm text-slate-400">—</span>;
  }
  const threshold = rebalanceThreshold;
  const ratio = Math.min(diff / threshold, 1.5);
  const pct = Math.min(ratio * 100, 100);
  // Breach states take their color from status so the bar and the
  // HealthBadge agree (red for CRITICAL, amber for WARN). In the healthy
  // band (status OK, devRatio ≤ 1.01) we nudge to yellow once we pass 80%
  // of the threshold — a "getting close" signal that also covers the
  // 1.0–1.01x tolerance dead zone where we're technically above threshold
  // but still in healthy state. /70 alpha so the inline `current / threshold`
  // text reads on top of the colored fill at any state.
  const fill =
    status === "CRITICAL"
      ? "bg-red-500/70"
      : status === "WARN"
        ? "bg-amber-500/70"
        : diff / threshold >= 0.8
          ? "bg-yellow-500/70"
          : "bg-emerald-500/70";

  // Raw deviation / threshold are stored in basis points (10000 bps = 100%),
  // but humans reason about this in percentages. Convert before rendering
  // so the parenthetical reads `(49.97% / 50.00%)` instead of the opaque
  // `(4997 / 5000 bps)` that the indexer emits.
  const diffPct = (diff / 100).toFixed(2);
  const thresholdPct = (threshold / 100).toFixed(2);

  return (
    <div
      className="flex flex-col gap-0.5"
      title={`Deviation ${diffPct}% of ${thresholdPct}% threshold`}
    >
      <div className="relative h-7 w-full rounded-md bg-slate-800 overflow-hidden mt-1">
        <div
          className={`absolute inset-y-0 left-0 transition-all ${fill}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-label="Deviation from rebalance threshold"
          // Use the same 0-100 % scale as the visual fill rather than the
          // raw diff/threshold pair: when the pool breaches, `diff` would
          // exceed `threshold` and aria-valuenow > aria-valuemax is an
          // invalid ARIA state. The precise diff/threshold pair still
          // reaches SRs via aria-valuetext, which they announce verbatim.
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${diffPct}% of ${thresholdPct}% threshold`}
        />
        <div className="absolute inset-0 flex items-center justify-between px-2 text-[11px] font-mono">
          <span className="text-white">{diffPct}%</span>
          <span className="text-slate-300">/ {thresholdPct}%</span>
        </div>
      </div>
      {breachStartedAt && (
        <BreachLine
          breachStartedAt={breachStartedAt}
          status={status}
          trippedByTxHash={trippedByTxHash}
          network={network}
        />
      )}
    </div>
  );
}

function BreachLine({
  breachStartedAt,
  status,
  trippedByTxHash,
  network,
}: {
  breachStartedAt: string;
  status: HealthStatus;
  trippedByTxHash: string | null;
  network: Network;
}) {
  const color = status === "CRITICAL" ? "text-red-400" : "text-amber-400";
  const labelText = `breach ${relativeTime(breachStartedAt)}`;
  const dateTime = new Date(Number(breachStartedAt) * 1000).toISOString();
  const title = formatTimestamp(breachStartedAt);
  const inner = (
    <>
      breach <time dateTime={dateTime}>{relativeTime(breachStartedAt)}</time>
      <span className="sr-only"> (started at {title})</span>
    </>
  );

  if (trippedByTxHash) {
    return (
      <a
        href={explorerTxUrl(network, trippedByTxHash)}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={`${labelText} — open trip transaction on the explorer`}
        className={`text-xs ${color} hover:text-indigo-400 transition-colors`}
      >
        {inner}
      </a>
    );
  }
  return (
    <span className={`text-xs ${color}`} title={title}>
      {inner}
    </span>
  );
}
