"use client";

import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import type { HealthStatus } from "@/lib/health";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";
import { relativeTime, formatTimestamp } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { InfoPopover } from "@/components/info-popover";
import { POOL_OPEN_BREACH_TX } from "@/lib/queries";
import { explorerTxUrl } from "@/lib/tokens";

const DEVIATION_EXPLAINER_BASE =
  "Live drift between the pool's internal price (implied by its current token reserves) and the oracle reference rate. The pool enters a rebalance breach when this deviation exceeds the Rebalance Threshold";

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

  // Look up the trip transaction so the "breach Xh ago" badge can link to
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

  // Surface the actual threshold inside the popover so operators don't
  // have to hop to Pool Config. Falls back to a generic note when the
  // indexer hasn't backfilled the threshold yet (sentinel 0).
  const thresholdSuffix =
    pool.rebalanceThreshold && pool.rebalanceThreshold > 0
      ? ` (${(pool.rebalanceThreshold / 100).toFixed(2)}%)`
      : "";
  const explainer = `${DEVIATION_EXPLAINER_BASE}${thresholdSuffix}.`;

  return (
    <div>
      <dt className="text-slate-400 flex items-center justify-between gap-1">
        <span className="inline-flex items-center gap-1">
          Deviation
          <InfoPopover
            label={`About Deviation. ${explainer}`}
            content={explainer}
          />
        </span>
        {breachStartedAt && (
          <BreachAge
            breachStartedAt={breachStartedAt}
            trippedByTxHash={trippedByTxHash}
            network={network}
            status={status}
          />
        )}
      </dt>
      <dd>
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
  // Only the missing-threshold case renders an em-dash — that's a real
  // "no data" condition (indexer sentinel-0). diff === 0 is the perfect
  // case (pool exactly on the oracle); render a 0%-filled bar + caption
  // so the tile still tells a positive story.
  if (!rebalanceThreshold || rebalanceThreshold === 0) {
    return <span className="text-sm text-slate-400">—</span>;
  }
  const diff = Number(priceDifference);
  const threshold = rebalanceThreshold;
  const ratio = Math.min(diff / threshold, 1.5);
  const pct = Math.min(ratio * 100, 100);
  // Breach states take their color from status so the bar and the
  // HealthBadge agree (red for CRITICAL, amber for WARN). In the healthy
  // band (status OK, devRatio ≤ 1.01) we nudge to yellow once we pass 80%
  // of the threshold — a "getting close" signal that also covers the
  // 1.0–1.01x tolerance dead zone where we're technically above threshold
  // but still in healthy state.
  const color =
    status === "CRITICAL"
      ? "bg-red-500"
      : status === "WARN"
        ? "bg-amber-500"
        : diff / threshold >= 0.8
          ? "bg-yellow-500"
          : "bg-emerald-500";

  // Raw deviation / threshold are stored in basis points (10000 bps = 100%),
  // but humans reason about this in percentages.
  const diffPct = (diff / 100).toFixed(2);
  const thresholdPct = (threshold / 100).toFixed(2);

  return (
    <div
      className="flex flex-col gap-0.5"
      title={`Deviation ${diffPct}% of ${thresholdPct}% threshold`}
    >
      {/* Wrap the 8px bar in a 20px row that matches the text-sm line-height
          of other cells' middle values (e.g. "Fresh", "Balanced") so the
          bottom-row subtitle sits on the same baseline across the header. */}
      <div className="flex h-5 items-center">
        <div className="h-2 w-full rounded-full bg-slate-700 mt-1">
          <div
            className={`h-2 rounded-full transition-all ${color}`}
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
            aria-valuetext={`${diffPct}% deviation, ${thresholdPct}% rebalance threshold`}
          />
        </div>
      </div>
      <span className="text-xs text-slate-500">
        {diffPct}% of {thresholdPct}% threshold
      </span>
    </div>
  );
}

function BreachAge({
  breachStartedAt,
  trippedByTxHash,
  network,
  status,
}: {
  breachStartedAt: string;
  trippedByTxHash: string | null;
  network: Network;
  status: HealthStatus;
}) {
  const color = status === "CRITICAL" ? "text-red-400" : "text-amber-400";
  const dateTime = new Date(Number(breachStartedAt) * 1000).toISOString();
  const inner = (
    <>
      breach <time dateTime={dateTime}>{relativeTime(breachStartedAt)}</time>
      <span className="sr-only">
        {" "}
        (started at {formatTimestamp(breachStartedAt)})
      </span>
    </>
  );
  if (trippedByTxHash) {
    return (
      <a
        href={explorerTxUrl(network, trippedByTxHash)}
        target="_blank"
        rel="noopener noreferrer"
        title={formatTimestamp(breachStartedAt)}
        aria-label={`breach ${relativeTime(breachStartedAt)} — open trip transaction on the explorer`}
        className={`text-xs font-normal hover:text-indigo-400 transition-colors ${color}`}
      >
        {inner}
      </a>
    );
  }
  return (
    <span
      className={`text-xs font-normal ${color}`}
      title={formatTimestamp(breachStartedAt)}
    >
      {inner}
    </span>
  );
}
