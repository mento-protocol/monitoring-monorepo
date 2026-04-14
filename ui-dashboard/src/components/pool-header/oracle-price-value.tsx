"use client";

import React from "react";
import type { Pool } from "@/lib/types";
import type { Network } from "@/lib/networks";
import { formatOraclePrice } from "@/lib/format";
import { chainlinkFeedUrl, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";

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
  const displayPrice =
    feedVal > 0 ? formatOraclePrice(inverted ? 1 / feedVal : feedVal) : "—";

  const chainlinkUrl =
    chainlinkFeedUrl(sym1, network.chainId) ??
    chainlinkFeedUrl(sym0, network.chainId);

  return (
    <span className="flex flex-col gap-0.5">
      {displayPrice !== "—" ? (
        <button
          type="button"
          onClick={() => setInverted((v) => !v)}
          title="Click to toggle price direction"
          className="font-mono text-white hover:text-indigo-300 transition-colors text-left"
        >
          1 {base} = {displayPrice} {quote}
          <span className="ml-1.5 text-xs text-slate-500">⇄</span>
        </button>
      ) : (
        <span className="text-slate-500">—</span>
      )}
      {chainlinkUrl ? (
        <a
          href={chainlinkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-slate-500 hover:text-indigo-400 transition-colors"
        >
          via Chainlink ↗
        </a>
      ) : (
        <span className="text-xs text-slate-500">via SortedOracles</span>
      )}
    </span>
  );
}
