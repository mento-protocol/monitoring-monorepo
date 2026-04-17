"use client";

import React from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { formatOraclePrice } from "@/lib/format";
import { chainlinkFeed, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";

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

  // Prefer the non-USDm leg first (more specific feed), fall back to the
  // USDm leg in the unusual case where both legs resolve to different pairs.
  // The legs must be addressed via `usdmIsToken0` — checking sym1 first
  // unconditionally picks the wrong leg when USDm happens to be token1.
  const nonUsdmSym = usdmIsToken0 ? sym1 : sym0;
  const usdmSym = usdmIsToken0 ? sym0 : sym1;
  const feed =
    chainlinkFeed(nonUsdmSym, network.chainId) ??
    chainlinkFeed(usdmSym, network.chainId);

  return (
    <span className="flex flex-col gap-0.5">
      {displayPrice !== "—" ? (
        <button
          type="button"
          onClick={() => setInverted((v) => !v)}
          aria-pressed={inverted}
          aria-label={`Showing 1 ${base} = ${displayPrice} ${quote}. Activate to invert direction.`}
          title={`1 ${base} = ${fullPrice} ${quote} · click to invert`}
          className="font-mono text-white hover:text-indigo-300 transition-colors text-left cursor-pointer"
        >
          1 {base} <span className="text-slate-500">⇄</span> {displayPrice}{" "}
          {quote}
        </button>
      ) : (
        <span className="text-slate-500">—</span>
      )}
      <span className="text-xs text-slate-500">
        via{" "}
        {feed ? (
          <a
            href={feed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-indigo-400 transition-colors"
          >
            Chainlink {feed.pair} oracle
          </a>
        ) : (
          "SortedOracles"
        )}
      </span>
    </span>
  );
}
