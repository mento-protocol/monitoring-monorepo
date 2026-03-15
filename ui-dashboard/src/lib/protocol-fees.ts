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

/** Tokens treated as $1.00 for USD conversion. */
// Note: "USD₮" (with Unicode ₮ U+20AE) is how USDT appears on Celo — the Celo
// token contract uses the Mongolian Tögrög sign as the ticker suffix.
const USD_PEGGED_SYMBOLS = new Set([
  "cUSD",
  "USDC",
  "axlUSDC",
  "USDT",
  "USD₮",
  "USDm",
  // AUSD (Monad) is the USD-pegged spoke token
  "AUSD",
]);

/**
 * FX rates for non-USD stablecoins (USD per 1 token).
 * Covers all Mento v3 tokens on Celo and Monad.
 * Approximate spot rates sourced from exchangerate-api.com — update periodically.
 * Hardcoded for v1 — acceptable for a monitoring dashboard.
 */
const FX_RATES: Record<string, number> = {
  // Legacy symbol (kept for backward-compat with any old indexed data)
  cEUR: 1.1455,
  // Celo v3 tokens (symbols from on-chain ERC20.symbol())
  EURm: 1.1455,
  GBPm: 1.3263,
  AUDm: 0.6993,
  CADm: 0.7299,
  CHFm: 1.2674,
  KESm: 0.0077,
  BRLm: 0.1905,
  COPm: 0.00027,
  GHSm: 0.0924,
  JPYm: 0.00627,
  NGNm: 0.00073,
  PHPm: 0.01675,
  XOFm: 0.00175,
  ZARm: 0.0593,
  // axlEUROC: euro-pegged bridged stablecoin (same rate as EUR)
  axlEUROC: 1.1455,
};

// ---------------------------------------------------------------------------
// USD conversion
// ---------------------------------------------------------------------------

/**
 * Convert a token amount to USD. Returns `null` for unknown tokens
 * so callers can track unconverted fees separately.
 */
export function tokenToUSD(symbol: string, amount: number): number | null {
  if (USD_PEGGED_SYMBOLS.has(symbol)) return amount;
  const rate = FX_RATES[symbol];
  if (rate !== undefined) return amount * rate;
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Maximum rows fetched by the PROTOCOL_FEE_TRANSFERS_ALL query. */
export const PROTOCOL_FEE_QUERY_LIMIT = 10_000;

export type ProtocolFeeSummary = {
  totalFeesUSD: number;
  fees24hUSD: number;
  /** True when at least one transfer had an unknown token symbol. */
  hasUnknownTokens: boolean;
  /** True when the query hit the row limit — all-time total is a lower bound. */
  isTruncated: boolean;
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
  let hasUnknownTokens = false;

  for (const t of transfers) {
    const amount = parseWei(t.amount, t.tokenDecimals);
    const usd = tokenToUSD(t.tokenSymbol, amount);
    if (usd === null) {
      hasUnknownTokens = true;
      continue;
    }
    totalFeesUSD += usd;
    if (Number(t.blockTimestamp) >= cutoff24h) {
      fees24hUSD += usd;
    }
  }

  return {
    totalFeesUSD,
    fees24hUSD,
    hasUnknownTokens,
    isTruncated: transfers.length >= PROTOCOL_FEE_QUERY_LIMIT,
  };
}
