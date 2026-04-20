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
    // Same `n > 0` guard as `snapshotUsdValue` — legacy rows pinned "0.00"
    // and we want those to fall through to the live-rate path, not show
    // as a deceptively confident $0.00. Drop after the next full reindex.
    if (Number.isFinite(n) && n > 0) return n;
  }
  const amt = transferAmountTokens(t);
  if (amt === null) return null;
  return tokenToUSD(t.tokenSymbol, amt, rates);
}

/** True when USD was computed client-side from current oracle, not indexer-pinned.
 * Must match `transferAmountUsd`'s guard exactly — otherwise a legacy "0.00"
 * row would price via live rate but render without the `~` prefix, looking
 * deceptively authoritative. Drop the numeric guard alongside the matching
 * TODO(post-reindex) in `transferAmountUsd` once legacy sentinels are gone. */
export function usdPricedFromLiveRate(t: BridgeTransfer): boolean {
  if (!t.usdValueAtSend) return true;
  const n = Number(t.usdValueAtSend);
  return !(Number.isFinite(n) && n > 0);
}
