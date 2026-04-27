"use client";

import React from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { formatOraclePrice, formatTimestamp, relativeTime } from "@/lib/format";
import { isOracleFresh } from "@/lib/health";
import { explorerTxUrl, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";

export function OraclePriceValue({
  pool,
  network,
}: {
  pool: Pool;
  network: Network;
}) {
  const [inverted, setInverted] = React.useState(false);
  const sym0 = tokenSymbol(network, pool.token0);
  const sym1 = tokenSymbol(network, pool.token1);
  const feedVal =
    pool.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 10 ** 24
      : 0;
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const titleToken = usdmIsToken0 ? sym1 : sym0;
  const quoteToken = usdmIsToken0 ? sym0 : sym1;
  const base = inverted ? quoteToken : titleToken;
  const quote = inverted ? titleToken : quoteToken;
  const rawPrice = inverted ? 1 / feedVal : feedVal;
  const displayPrice = feedVal > 0 ? formatOraclePrice(rawPrice) : "—";
  // Full precision for the hover tooltip — 12dp comfortably preserves the
  // indexer's 24-decimal fixed-point price across any FX pair.
  const fullPrice =
    feedVal > 0
      ? rawPrice.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")
      : "";

  const nowSeconds = Math.floor(Date.now() / 1000);
  const fresh = isOracleFresh(pool, nowSeconds, network.chainId);
  const priceColor = fresh ? "text-white" : "text-red-400";
  const subColor = fresh ? "text-slate-500" : "text-red-400";

  const hasTs = pool.oracleTimestamp != null && pool.oracleTimestamp !== "0";
  const updatedLabel = hasTs
    ? `Updated ${relativeTime(pool.oracleTimestamp!)}`
    : null;
  const updatedTitle = hasTs
    ? formatTimestamp(pool.oracleTimestamp!)
    : undefined;
  const updatedHref =
    hasTs && pool.oracleTxHash
      ? explorerTxUrl(network, pool.oracleTxHash)
      : null;

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
      {updatedLabel &&
        (updatedHref ? (
          <a
            href={updatedHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-xs ${subColor} hover:text-indigo-400 transition-colors`}
            title={updatedTitle}
          >
            {updatedLabel}
            {!fresh && " · stale"}
          </a>
        ) : (
          <span className={`text-xs ${subColor}`} title={updatedTitle}>
            {updatedLabel}
            {!fresh && " · stale"}
          </span>
        ))}
    </span>
  );
}
