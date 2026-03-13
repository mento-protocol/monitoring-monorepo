/**
 * Protocol fee aggregation from indexed ProtocolFeeTransfer entities.
 *
 * The Envio indexer stores every ERC20 Transfer to the yield split address.
 * This module converts those transfers to USD and aggregates total + 24h fees.
 */

import { parseWei } from "./format";
import type { ProtocolFeeTransfer } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const YIELD_SPLIT_ADDRESS =
  "0x0Dd57F6f181D0469143fe9380762d8a112e96e4a" as const;

/** Tokens treated as $1.00 for USD conversion. */
const USD_PEGGED_SYMBOLS = new Set(["cUSD", "USDC", "axlUSDC", "USDT", "USDm"]);

/**
 * Approximate FX rates for non-USD stablecoins.
 * Hardcoded for v1 — acceptable for a monitoring dashboard.
 */
const FX_RATES: Record<string, number> = {
  cEUR: 1.08,
  GBPm: 1.27,
  KESm: 0.0077,
  AUSD: 1.0,
};

// ---------------------------------------------------------------------------
// USD conversion
// ---------------------------------------------------------------------------

function tokenToUSD(symbol: string, amount: number): number {
  if (USD_PEGGED_SYMBOLS.has(symbol)) return amount;
  const rate = FX_RATES[symbol];
  if (rate !== undefined) return amount * rate;
  // Unknown token — excluded from USD total
  console.warn(
    `[protocol-fees] Unknown fee token "${symbol}" — excluded from USD total`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ProtocolFeeSummary = {
  totalFeesUSD: number;
  fees24hUSD: number;
};

/**
 * Aggregates indexed ProtocolFeeTransfer rows into USD totals.
 * Splits by a 24h timestamp cutoff for the daily metric.
 */
export function aggregateProtocolFees(
  transfers: ProtocolFeeTransfer[],
): ProtocolFeeSummary {
  const cutoff24h = Math.floor(Date.now() / 1000) - 86400;
  let totalFeesUSD = 0;
  let fees24hUSD = 0;

  for (const t of transfers) {
    const amount = parseWei(t.amount, t.tokenDecimals);
    const usd = tokenToUSD(t.tokenSymbol, amount);
    totalFeesUSD += usd;
    if (Number(t.blockTimestamp) >= cutoff24h) {
      fees24hUSD += usd;
    }
  }

  return { totalFeesUSD, fees24hUSD };
}
