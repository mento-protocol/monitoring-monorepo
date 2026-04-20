import { parseWei } from "@/lib/format";
import { tokenToUSD, type OracleRateMap } from "@/lib/tokens";
import type { BridgeTransfer } from "@/lib/types";

export function transferAmountTokens(t: BridgeTransfer): number | null {
  if (!t.amount) return null;
  return parseWei(t.amount, t.tokenDecimals ?? 18);
}

/**
 * USD value of a transfer. Prefers `usdValueAtSend` (indexer-pinned at the
 * source-chain block) when present; otherwise falls back to live oracle rates
 * — which loses the "at-send" timestamp precision but is better than a blank
 * cell for rows the indexer didn't price.
 *
 * Indexer USD-pricing is not implemented yet (plan §1.5 deferred), so the
 * fallback path is the only path today. The two-branch structure is in place
 * so the indexer can start writing `usdValueAtSend` without a UI change.
 */
export function transferAmountUsd(
  t: BridgeTransfer,
  rates: OracleRateMap,
): number | null {
  if (t.usdValueAtSend) {
    const n = Number(t.usdValueAtSend);
    if (Number.isFinite(n)) return n;
  }
  const amt = transferAmountTokens(t);
  if (amt === null) return null;
  return tokenToUSD(t.tokenSymbol, amt, rates);
}

/** True when USD was computed client-side from current oracle, not indexer-pinned. */
export function usdPricedFromLiveRate(t: BridgeTransfer): boolean {
  return !t.usdValueAtSend;
}
