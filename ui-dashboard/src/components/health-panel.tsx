"use client";

import { useEffect, useMemo, useState } from "react";
import type { OracleSnapshot, Pool } from "@/lib/types";
import { HealthBadge } from "@/components/badges";
import {
  computeHealthStatus,
  getOracleStalenessThreshold,
  isOracleFresh,
} from "@/lib/health";
import {
  computeBinaryHealthWindow,
  formatBinaryHealthPct,
  formatNines,
  normalizeWindowSnapshots,
} from "@/lib/pool-health-score";
import { isWeekend } from "@/lib/weekend";
import {
  tokenSymbol,
  chainlinkFeedUrl,
  explorerTxUrl,
  USDM_SYMBOLS,
} from "@/lib/tokens";
import { relativeTime, formatTimestamp } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import {
  ORACLE_SNAPSHOT_PREDECESSOR,
  ORACLE_SNAPSHOTS_WINDOW,
} from "@/lib/queries";
import { useNetwork } from "@/components/network-provider";

const HEALTH_WINDOW_LIMIT = 1000;
/** Fetch one extra so we can detect truncation without a separate count query. */
const HEALTH_WINDOW_QUERY_LIMIT = HEALTH_WINDOW_LIMIT + 1;
import { useRebalanceCheck } from "@/hooks/use-rebalance-check";
import type { RebalanceCheckResult } from "@/lib/rebalance-check";

/** Format a price float with smart decimal places.
 * Prices near 1.0 (stablecoins) → 4dp; others → 6dp. */
function formatPrice(price: number): string {
  if (price <= 0) return "—";
  const dp = price > 0.9 && price < 1.1 ? 4 : 6;
  return price.toFixed(dp);
}

/** Parse raw 24dp oracle price into the feed direction value (feedToken/USD).
 * Always returns the raw feed value — display direction is handled at the call site. */
function rawFeedValue(oraclePrice: string): number {
  if (!oraclePrice || oraclePrice === "0") return 0;
  return Number(oraclePrice) / 10 ** 24;
}

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
  const [priceInverted, setPriceInverted] = useState(false);
  const isVirtual = pool.source?.includes("virtual");
  const hasHealthData =
    pool.hasHealthData === true || pool.healthStatus !== undefined;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleAge =
    pool.oracleTimestamp && pool.oracleTimestamp !== "0"
      ? nowSeconds - Number(pool.oracleTimestamp)
      : Infinity;
  const stalenessThreshold = getOracleStalenessThreshold(pool, network.chainId);
  const oracleIsFresh = isOracleFresh(pool, nowSeconds, network.chainId);

  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);

  const feedVal = rawFeedValue(pool.oraclePrice ?? "0");
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const titleToken = usdmIsToken0 ? sym1 : sym0;
  const quoteToken = usdmIsToken0 ? sym0 : sym1;
  const displayBase = priceInverted ? quoteToken : titleToken;
  const displayQuote = priceInverted ? titleToken : quoteToken;
  const displayPrice =
    feedVal > 0 ? formatPrice(priceInverted ? 1 / feedVal : feedVal) : "—";

  const chainlinkUrl =
    chainlinkFeedUrl(sym1, network.chainId) ??
    chainlinkFeedUrl(sym0, network.chainId);

  const [windowAnchorMs, setWindowAnchorMs] = useState(
    () => Math.floor(Date.now() / 60_000) * 60_000,
  );

  useEffect(() => {
    const updateWindowAnchor = () => {
      setWindowAnchorMs(Math.floor(Date.now() / 60_000) * 60_000);
    };

    const intervalId = setInterval(updateWindowAnchor, 60_000);
    return () => clearInterval(intervalId);
  }, []);

  const windowEnd = Math.floor(windowAnchorMs / 1000);
  const windowStart = windowEnd - 24 * 3600;
  const shouldFetchHealth = !pool.source?.includes("virtual");

  const { data: healthWindowData, error: healthWindowError } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(
    shouldFetchHealth ? ORACLE_SNAPSHOTS_WINDOW : null,
    {
      poolId: pool.id,
      from: String(windowStart),
      to: String(windowEnd),
      limit: HEALTH_WINDOW_QUERY_LIMIT,
    },
    60_000,
  );
  const { data: predecessorData, error: predecessorError } = useGQL<{
    OracleSnapshot: OracleSnapshot[];
  }>(
    shouldFetchHealth ? ORACLE_SNAPSHOT_PREDECESSOR : null,
    {
      poolId: pool.id,
      before: String(windowStart),
    },
    60_000,
  );

  const { snapshotsAsc: windowSnapshotsAsc, truncated: windowWasTruncated } =
    useMemo(() => {
      const raw = healthWindowData?.OracleSnapshot ?? [];
      return normalizeWindowSnapshots(raw, HEALTH_WINDOW_LIMIT);
    }, [healthWindowData]);
  const predecessor = predecessorData?.OracleSnapshot?.[0];
  const healthSnapshots = useMemo(() => {
    // Spread into a new array before sorting to avoid mutating the memoized
    // windowSnapshotsAsc reference (React immutability invariant).
    const out = predecessor
      ? [predecessor, ...windowSnapshotsAsc]
      : [...windowSnapshotsAsc];
    return out.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }, [predecessor, windowSnapshotsAsc]);

  // If the query was truly truncated (> limit), narrow windowStart to the
  // oldest kept snapshot so we score only the covered portion.
  const effectiveWindowStart = useMemo(() => {
    if (windowWasTruncated && windowSnapshotsAsc.length > 0) {
      return Math.max(windowStart, Number(windowSnapshotsAsc[0]!.timestamp));
    }
    return windowStart;
  }, [windowSnapshotsAsc, windowStart, windowWasTruncated]);

  const health24h = useMemo(
    () =>
      computeBinaryHealthWindow(
        healthSnapshots,
        pool,
        effectiveWindowStart,
        windowEnd,
      ),
    [healthSnapshots, pool, windowEnd, effectiveWindowStart],
  );

  const allTimeScore =
    pool.hasHealthData === true && Number(pool.healthTotalSeconds ?? "0") > 0
      ? Number(pool.healthBinarySeconds ?? "0") /
        Number(pool.healthTotalSeconds ?? "1")
      : null;

  const healthQueryError = healthWindowError || predecessorError;

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
          {/* Left: Oracle health stats */}
          <dl
            className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm ${showRebalanceDiag ? "lg:flex-1 lg:min-w-0" : ""}`}
          >
            {/* Oracle Status */}
            <div>
              <dt className="text-slate-400 mb-1">Oracle Status</dt>
              <dd className="flex flex-col gap-0.5">
                <span
                  className={
                    oracleIsFresh ? "text-emerald-400" : "text-red-400"
                  }
                >
                  {oracleIsFresh ? "✓ Fresh" : "✗ Stale"}
                </span>
                <span className="text-xs text-slate-500">
                  Expiry window {stalenessThreshold}s
                </span>
                {pool.oracleTimestamp &&
                  pool.oracleTimestamp !== "0" &&
                  (pool.oracleTxHash ? (
                    <a
                      href={explorerTxUrl(network, pool.oracleTxHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-slate-400 hover:text-indigo-400 transition-colors"
                      title={formatTimestamp(pool.oracleTimestamp)}
                    >
                      Last updated {relativeTime(pool.oracleTimestamp)}{" "}
                      {oracleAge !== Infinity ? `(${oracleAge}s ago)` : ""} ↗
                    </a>
                  ) : (
                    <span
                      className="text-xs text-slate-400"
                      title={formatTimestamp(pool.oracleTimestamp)}
                    >
                      Last updated {relativeTime(pool.oracleTimestamp)}{" "}
                      {oracleAge !== Infinity ? `(${oracleAge}s ago)` : ""}
                    </span>
                  ))}
              </dd>
            </div>

            {/* Oracle Price */}
            <div>
              <dt className="text-slate-400 mb-1">
                Oracle Price
                {chainlinkUrl && (
                  <a
                    href={chainlinkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View Chainlink data feed"
                    className="ml-2 text-xs text-slate-500 hover:text-indigo-400 transition-colors"
                  >
                    ↗ Chainlink
                  </a>
                )}
              </dt>
              <dd className="text-white font-mono">
                {displayPrice !== "—" ? (
                  <button
                    type="button"
                    onClick={() => setPriceInverted((v) => !v)}
                    title="Click to toggle price direction"
                    className="hover:text-indigo-300 transition-colors cursor-pointer text-left"
                  >
                    1 {displayBase} = {displayPrice} {displayQuote}
                    <span className="ml-1.5 text-xs text-slate-500">⇄</span>
                  </button>
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

            {/* 24h health score */}
            <div>
              <dt className="text-slate-400 mb-1">24h Health Score</dt>
              <dd className="text-white">
                {healthQueryError ? (
                  <span className="text-amber-400 text-xs">Query failed</span>
                ) : health24h.score == null ? (
                  <span className="text-slate-500">N/A</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-white">
                      {formatBinaryHealthPct(health24h.score)}
                    </span>
                    <span className="text-xs text-slate-500">
                      {health24h.hasEnoughDataForNines
                        ? formatNines(health24h.score)
                        : `${health24h.observedHours.toFixed(1)}h observed`}
                    </span>
                  </div>
                )}
              </dd>
            </div>

            {/* All-time health score */}
            <div>
              <dt className="text-slate-400 mb-1">All-time Health</dt>
              <dd className="text-white">
                {allTimeScore == null ? (
                  <span className="text-slate-500">N/A</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-white">
                      {formatBinaryHealthPct(allTimeScore)}
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatNines(allTimeScore)}
                    </span>
                  </div>
                )}
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

          {/* Right: Rebalance diagnostics (only when pool needs rebalancing) */}
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

// ---------------------------------------------------------------------------
// Rebalance diagnostics panel (right side of health panel)
// ---------------------------------------------------------------------------

function RebalanceDiagnostics({
  result,
  error,
}: {
  result: RebalanceCheckResult | null;
  error: Error | undefined;
}) {
  // Headline / strategy type / write-link live on the pool header top row.
  // This panel only exists to carry info the header can't fit: the decoded
  // revert reason and strategy-specific enrichment.
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

// ---------------------------------------------------------------------------
// Strategy enrichment details
// ---------------------------------------------------------------------------

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
