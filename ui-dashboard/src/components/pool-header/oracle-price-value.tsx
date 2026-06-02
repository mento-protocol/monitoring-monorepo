"use client";

import React from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { formatOraclePrice, formatTimestamp, relativeTime } from "@/lib/format";
import {
  getOracleStalenessThreshold,
  isOracleFresh,
  oracleFreshnessTimestamp,
} from "@/lib/health";
import { explorerTxUrl, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";

function oracleFreshnessDisplay(pool: Pool, network: Network) {
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
    lastLabel: `last ${relativeTime(freshnessTsString)}`,
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

  const nowSeconds = Math.floor(Date.now() / 1000);
  const fresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const priceColor = fresh ? "text-white" : "text-red-400";
  const subColor = fresh ? "text-slate-500" : "text-red-400";

  const expiryMinutes = Math.round(
    getOracleStalenessThreshold(pool, network.chainId) / 60,
  );
  const { updatedTitle, updatedHref, lastLabel } = oracleFreshnessDisplay(
    pool,
    network,
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
          {` / ${expiryMinutes}m expiry`}
          {!fresh && " · stale"}
        </span>
      )}
    </span>
  );
}
