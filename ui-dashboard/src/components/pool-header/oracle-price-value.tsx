"use client";

import React from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import {
  formatOraclePrice,
  formatTimestamp,
  relativeTime,
  relativeTimeOrTimestamp,
} from "@/lib/format";
import {
  getOracleStalenessThreshold,
  isOracleFresh,
  oracleFreshnessTimestamp,
} from "@/lib/health";
import { explorerTxUrl, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import { useNowSeconds } from "@/hooks/use-now-seconds";

// `nowSeconds === null` (server + hydration render) falls back to the absolute
// timestamp so the SSR-prefetched header can't mismatch on the second-granularity
// "N ago" label; the live label appears after mount.
function oracleFreshnessDisplay(
  pool: Pool,
  network: Network,
  nowSeconds: number | null,
) {
  const freshnessTs = oracleFreshnessTimestamp(pool);
  if (freshnessTs === 0) {
    return { updatedTitle: undefined, updatedHref: null, lastLabel: null };
  }

  const freshnessTsString = String(freshnessTs);
  return {
    updatedTitle: formatTimestamp(freshnessTsString),
    updatedHref:
      pool.oracleTxHash && pool.oracleTimestamp === freshnessTsString
        ? explorerTxUrl(network, pool.oracleTxHash)
        : null,
    lastLabel:
      nowSeconds === null
        ? relativeTimeOrTimestamp(freshnessTsString, null)
        : `last ${relativeTime(freshnessTsString, nowSeconds * 1000)}`,
  };
}

function oraclePriceDisplay(pool: Pool, network: Network, inverted: boolean) {
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  const feedVal =
    pool.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 10 ** 24
      : 0;
  const titleToken = USDM_SYMBOLS.has(sym0) ? sym1 : sym0;
  const quoteToken = USDM_SYMBOLS.has(sym0) ? sym0 : sym1;
  const base = inverted ? quoteToken : titleToken;
  const quote = inverted ? titleToken : quoteToken;
  const rawPrice = inverted ? 1 / feedVal : feedVal;
  const displayPrice = feedVal > 0 ? formatOraclePrice(rawPrice) : "—";
  const fullPrice =
    feedVal > 0
      ? rawPrice.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")
      : "";
  return { base, quote, displayPrice, fullPrice };
}

export function OraclePriceValue({
  pool,
  network,
}: {
  pool: Pool;
  network: Network;
}) {
  const [inverted, setInverted] = React.useState(false);
  const { base, quote, displayPrice, fullPrice } = oraclePriceDisplay(
    pool,
    network,
    inverted,
  );

  // On the server + hydration render (liveNowSeconds === null) evaluate freshness
  // against the oracle's own timestamp so it deterministically reads "fresh"
  // (no red flash / hydration mismatch); the live check runs after mount.
  const liveNowSeconds = useNowSeconds();
  const nowSeconds = liveNowSeconds ?? oracleFreshnessTimestamp(pool);
  const fresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const priceColor = fresh ? "text-white" : "text-red-400";
  const subColor = fresh ? "text-slate-500" : "text-red-400";

  const expirySeconds = getOracleStalenessThreshold(pool, network.chainId);
  const expiryMinutes =
    expirySeconds > 0 ? Math.round(expirySeconds / 60) : null;
  const { updatedTitle, updatedHref, lastLabel } = oracleFreshnessDisplay(
    pool,
    network,
    liveNowSeconds,
  );

  return (
    <span className="flex flex-col gap-0.5">
      {displayPrice !== "—" ? (
        <button
          type="button"
          onClick={() => setInverted((v) => !v)}
          aria-pressed={inverted}
          aria-label={`Showing 1 ${base} = ${displayPrice} ${quote}.${fresh ? "" : " Oracle is stale."} Activate to invert direction.`}
          title={`1 ${base} = ${fullPrice} ${quote} · click to invert`}
          className={`font-mono ${priceColor} hover:text-indigo-300 transition-colors text-left cursor-pointer`}
        >
          1 {base} <span className="text-slate-500">⇄</span> {displayPrice}{" "}
          {quote}
        </button>
      ) : (
        <span className="text-slate-500">—</span>
      )}
      {lastLabel && (
        <span className={`text-xs ${subColor}`}>
          {updatedHref ? (
            <a
              href={updatedHref}
              target="_blank"
              rel="noopener noreferrer"
              title={updatedTitle}
              className="hover:text-indigo-400 transition-colors"
            >
              {lastLabel}
            </a>
          ) : (
            <span title={updatedTitle}>{lastLabel}</span>
          )}
          {expiryMinutes !== null && ` / ${expiryMinutes}m expiry`}
          {!fresh && " · stale"}
        </span>
      )}
    </span>
  );
}
