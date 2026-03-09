"use client";

import { useState } from "react";
import type { Pool } from "@/lib/types";
import { HealthBadge } from "@/components/badges";
import { computeHealthStatus } from "@/lib/health";
import {
  tokenSymbol,
  chainlinkFeedUrl,
  explorerTxUrl,
  USDM_SYMBOLS,
} from "@/lib/tokens";
import { relativeTime, formatTimestamp } from "@/lib/format";
import { useNetwork } from "@/components/network-provider";

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
  const hasHealthData = pool.healthStatus !== undefined;

  // Compute real-time oracle freshness client-side.
  // Matches SortedOracles.isOldestReportExpired() — Celo mainnet uses
  // reportExpirySeconds = 300s (5 min). See health.ts for details.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oracleAge =
    pool.oracleTimestamp && pool.oracleTimestamp !== "0"
      ? nowSeconds - Number(pool.oracleTimestamp)
      : Infinity;
  const ORACLE_STALE_THRESHOLD = 300; // SortedOracles.reportExpirySeconds()
  const isOracleFresh = oracleAge <= ORACLE_STALE_THRESHOLD; // age <= 300 is fresh, > 300 is stale

  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);

  // Oracle price is stored as feed direction ("feedToken/USD"). Pool title
  // (from poolName()) puts the non-USDm token first, which matches feed direction:
  //   USDm/GBPm pool → title "GBPm/USDm" → "1 GBPm = 1.34 USDm" (feed = GBP/USD)
  //   USDT/USDm pool → title "USDT/USDm" → "1 USDT = 1.00 USDm" (feed = USDT/USD)
  // So "title direction" = raw feed direction (no inversion).
  const feedVal = rawFeedValue(pool.oraclePrice ?? "0");
  // titleToken is the non-USDm token (always listed first in the pool title)
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const titleToken = usdmIsToken0 ? sym1 : sym0;
  const quoteToken = usdmIsToken0 ? sym0 : sym1;
  // In title direction: 1 titleToken = feedVal quoteToken
  // Inverted:          1 quoteToken = (1/feedVal) titleToken
  const displayBase = priceInverted ? quoteToken : titleToken;
  const displayQuote = priceInverted ? titleToken : quoteToken;
  const displayPrice =
    feedVal > 0 ? formatPrice(priceInverted ? 1 / feedVal : feedVal) : "—";

  // SortedOracles rates are "feedToken / USD". In USDm-based pools the
  // non-USDm token is always sym1 (e.g. GBPm, USDC), so try sym1 first.
  // For USDT/USDm the non-USDm token is sym0, so fall back to that.
  const chainlinkUrl =
    chainlinkFeedUrl(sym1, network.chainId) ??
    chainlinkFeedUrl(sym0, network.chainId);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">Health Status</h2>
        <HealthBadge status={computeHealthStatus(pool)} />
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
                className={isOracleFresh ? "text-emerald-400" : "text-red-400"}
              >
                {isOracleFresh ? "✓ Fresh" : "✗ Stale"}
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
                    Last updated {relativeTime(pool.oracleTimestamp)} ↗
                  </a>
                ) : (
                  <span
                    className="text-xs text-slate-400"
                    title={formatTimestamp(pool.oracleTimestamp)}
                  >
                    Last updated {relativeTime(pool.oracleTimestamp)}
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
