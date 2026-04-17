"use client";

import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import type { HealthStatus } from "@/lib/health";
import { computeHealthStatus, isOracleFresh } from "@/lib/health";
import { isWeekend } from "@/lib/weekend";
import { relativeTime, formatTimestamp } from "@/lib/format";

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

  if (isVirtual) return null;
  if (!hasHealthData) return null;
  if (!oracleIsFresh && isWeekend()) return null;

  const status = computeHealthStatus(pool, network.chainId);

  return (
    <div className="min-w-44">
      <dt className="text-slate-400">Deviation</dt>
      <dd>
        <DeviationBar
          priceDifference={pool.priceDifference ?? "0"}
          rebalanceThreshold={pool.rebalanceThreshold ?? 0}
          status={status}
        />
        {pool.deviationBreachStartedAt &&
          pool.deviationBreachStartedAt !== "0" && (
            // Match the subtext color to the badge/bar severity: during the
            // 1h rebalance grace window the status stays WARN even though
            // devRatio > 1.0, so red would contradict the amber bar.
            <div
              className={`mt-1 text-xs ${
                status === "CRITICAL" ? "text-red-400" : "text-amber-400"
              }`}
              title={formatTimestamp(pool.deviationBreachStartedAt)}
            >
              Breach started{" "}
              <time
                dateTime={new Date(
                  Number(pool.deviationBreachStartedAt) * 1000,
                ).toISOString()}
              >
                {relativeTime(pool.deviationBreachStartedAt)}
              </time>
              {/* sr-only so screen readers in browse mode read the exact
                  time alongside the relative label, not only via the
                  hover-only title. */}
              <span className="sr-only">
                {" "}
                (at {formatTimestamp(pool.deviationBreachStartedAt)})
              </span>
            </div>
          )}
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
  // overage). Within 1% below the limit reads as "At threshold" — users
  // read "0.3% below threshold" as if the pool is safely under when it's
  // actually on the verge. Overages still get the explicit "% above"
  // signal at any magnitude.
  const deltaPct = (Math.abs(diff - threshold) / threshold) * 100;
  const AT_THRESHOLD_TOLERANCE_PCT = 1;
  const atThreshold =
    diff === threshold ||
    (diff < threshold && deltaPct <= AT_THRESHOLD_TOLERANCE_PCT);
  const deltaLabel = atThreshold
    ? "At threshold"
    : diff > threshold
      ? `${deltaPct.toFixed(1)}% above threshold`
      : `${deltaPct.toFixed(1)}% below threshold`;

  return (
    <div
      className="flex flex-col gap-0.5"
      title={`Deviation ${diffPct}% of ${thresholdPct}% threshold`}
    >
      {/* Wrap the 8px bar in a 20px row that matches the text-sm line-height
          of other cells' middle values (e.g. "Fresh", "Balanced") so the
          bottom-row subtitle sits on the same baseline across the header.
          `mt-0.5` nudges the bar ~2px below geometric center to match the
          optical center of text-sm glyphs (text sits below the cap line, so
          a geometrically centered bar reads slightly high). */}
      <div className="flex h-5 items-center">
        <div className="h-2 w-44 rounded-full bg-slate-700 mt-1">
          <div
            className={`h-2 rounded-full transition-all ${color}`}
            style={{ width: `${pct}%` }}
            role="progressbar"
            // Use the same 0-100 % scale as the visual fill rather than the
            // raw diff/threshold pair: when the pool breaches, `diff` would
            // exceed `threshold` and aria-valuenow > aria-valuemax is an
            // invalid ARIA state. The precise diff/threshold pair + breach
            // direction still reaches SRs via aria-valuetext, which they
            // announce verbatim.
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${deltaLabel} (${diffPct}% of ${thresholdPct}% threshold)`}
          />
        </div>
      </div>
      <span className="text-xs text-slate-500">{deltaLabel}</span>
    </div>
  );
}
