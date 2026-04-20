import { parseWei } from "@/lib/format";
import { tokenToUSD, type OracleRateMap } from "@/lib/tokens";
import type { BridgeTransfer } from "@/lib/types";

export function transferAmountTokens(t: BridgeTransfer): number | null {
  if (!t.amount) return null;
  return parseWei(t.amount, t.tokenDecimals ?? 18);
}

/** Prefers indexer-pinned `usdValueAtSend`; falls back to live oracle rates
 * (loses at-send precision but beats a blank cell). Indexer pricing is not
 * wired yet — the fallback path is currently the only one — but the branch
 * is here so the indexer can start pinning values without a UI change. */
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
