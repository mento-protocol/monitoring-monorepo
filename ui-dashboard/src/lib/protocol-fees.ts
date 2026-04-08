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
 * Token symbols the indexer emits when it cannot resolve the on-chain symbol
 * (e.g. tokens not yet in @mento-protocol/contracts). These are silently
 * skipped rather than flagging the summary as approximate.
 */
const UNRESOLVED_SYMBOLS = new Set(["UNKNOWN"]);

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
  fees7dUSD: number;
  fees30dUSD: number;
  /**
   * Symbols that appeared in all-time transfers but have no USD conversion.
   * Empty array = all tokens priced. Non-empty = all-time total is approximate.
   */
  unpricedSymbols: string[];
  /**
   * Symbols that appeared in 24h transfers but have no USD conversion.
   * Separate from unpricedSymbols so the 24h tile is not marked approximate
   * when an unpriced token only appears in older history.
   */
  unpricedSymbols24h: string[];
  /**
   * Number of transfers where the indexer could not resolve the token symbol
   * (stored as "UNKNOWN" placeholder). These are excluded from USD totals —
   * if this is non-zero the all-time total may be understated even though
   * unpricedSymbols is empty. Surfaced so the UI can flag approximate totals.
   */
  unresolvedCount: number;
  /**
   * Like unresolvedCount but scoped to the last 24h window.
   * Non-zero means fees24hUSD is understated and the 24h tile should show ≈.
   */
  unresolvedCount24h: number;
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff24h = nowSeconds - 86400;
  const cutoff7d = nowSeconds - 7 * 86400;
  const cutoff30d = nowSeconds - 30 * 86400;
  let totalFeesUSD = 0;
  let fees24hUSD = 0;
  let fees7dUSD = 0;
  let fees30dUSD = 0;
  const unpricedSymbolSet = new Set<string>();
  const unpricedSymbols24hSet = new Set<string>();
  let unresolvedCount = 0;
  let unresolvedCount24h = 0;

  for (const t of transfers) {
    const ts = Number(t.blockTimestamp);

    // Count indexer placeholder symbols — excluded from USD totals but tracked
    // so the UI can signal the total may be understated if resolution keeps
    // failing (persistent RPC issue, non-standard token).
    if (UNRESOLVED_SYMBOLS.has(t.tokenSymbol)) {
      unresolvedCount++;
      if (ts >= cutoff24h) unresolvedCount24h++;
      continue;
    }
    const amount = parseWei(t.amount, t.tokenDecimals);
    const usd = tokenToUSD(t.tokenSymbol, amount);
    if (usd === null) {
      unpricedSymbolSet.add(t.tokenSymbol);
      if (ts >= cutoff24h) unpricedSymbols24hSet.add(t.tokenSymbol);
      continue;
    }
    totalFeesUSD += usd;
    if (ts >= cutoff24h) fees24hUSD += usd;
    if (ts >= cutoff7d) fees7dUSD += usd;
    if (ts >= cutoff30d) fees30dUSD += usd;
  }

  return {
    totalFeesUSD,
    fees24hUSD,
    fees7dUSD,
    fees30dUSD,
    unpricedSymbols: Array.from(unpricedSymbolSet).sort(),
    unpricedSymbols24h: Array.from(unpricedSymbols24hSet).sort(),
    unresolvedCount,
    unresolvedCount24h,
    isTruncated: transfers.length >= PROTOCOL_FEE_QUERY_LIMIT,
  };
}
