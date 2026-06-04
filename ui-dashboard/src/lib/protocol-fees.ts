/**
 * Protocol fee aggregation from indexed `PoolDailyFeeSnapshot` entities.
 *
 * Source of truth: each snapshot is one row per (chainId, pool, UTC day),
 * pre-rolled by the indexer. Hybrid USD pricing: USD-pegged tokens land in
 * `feesUsdWei` indexer-side; FX tokens are dashboard-priced from the
 * parallel `tokens[]`/`tokenSymbols[]`/`tokenDecimals[]`/`amounts[]` arrays
 * via the live oracle rate map.
 */

import { parseWei } from "./format";
import { isUsdPegged, tokenToUSD, type OracleRateMap } from "./tokens";
import type { PoolDailyFeeSnapshot } from "./types";

/**
 * Token symbols the indexer emits when it cannot resolve the on-chain symbol.
 * Excluded from USD totals; tracked via `unresolvedCount` so the UI can flag
 * the summary as approximate.
 */
export const UNRESOLVED_SYMBOLS = new Set(["UNKNOWN"]);

const SECS_PER_DAY = 86_400;

/**
 * Yields one `(sym, rawAmount, decimals)` triple per defined slot of the
 * parallel `tokenSymbols[]` / `amounts[]` / `tokenDecimals[]` arrays the
 * indexer emits on each `PoolDailyFeeSnapshot`. Indices where any of the
 * three is `undefined` are skipped — the indexer's invariant says they don't
 * mismatch in practice, but `noUncheckedIndexedAccess` requires the guard
 * and centralising it here keeps the per-aggregator complexity down.
 */
export function* iterateFeeSnapshotTokens(
  s: Pick<PoolDailyFeeSnapshot, "tokenSymbols" | "amounts" | "tokenDecimals">,
): Iterable<{ sym: string; rawAmount: string; decimals: number }> {
  for (let i = 0; i < s.tokenSymbols.length; i++) {
    const sym = s.tokenSymbols[i];
    const rawAmount = s.amounts[i];
    const decimals = s.tokenDecimals[i];
    if (
      sym !== undefined &&
      rawAmount !== undefined &&
      decimals !== undefined
    ) {
      yield { sym, rawAmount, decimals };
    }
  }
}

export type ProtocolFeeSummary = {
  totalFeesUSD: number;
  fees24hUSD: number;
  fees7dUSD: number;
  fees30dUSD: number;
  /**
   * Symbols that appeared in all-time snapshots but have no USD conversion.
   * Empty array = all tokens priced. Non-empty = all-time total is approximate.
   */
  unpricedSymbols: string[];
  /**
   * Symbols that appeared in 24h snapshots but have no USD conversion.
   * Separate from `unpricedSymbols` so the 24h tile is not marked approximate
   * when an unpriced token only appears in older history.
   */
  unpricedSymbols24h: string[];
  /**
   * Number of UNKNOWN-symbol slots across all-time snapshots — excluded
   * from USD totals. Non-zero ⇒ all-time total may be understated.
   */
  unresolvedCount: number;
  /** Like `unresolvedCount` but scoped to the 24h window. */
  unresolvedCount24h: number;
};

/**
 * Aggregates `PoolDailyFeeSnapshot` rows into chain-level USD totals across
 * 24h / 7d / 30d / all-time. Window inclusion is full-day
 * (`s.timestamp >= now - windowSeconds`) — matches the table and chart
 * conventions.
 */
export function aggregateProtocolFees(
  snapshots: ReadonlyArray<PoolDailyFeeSnapshot>,
  rates: OracleRateMap,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ProtocolFeeSummary {
  // Day-aligned cutoffs. Snapshot timestamps are already UTC-midnight buckets
  // (`(ts / 86400) * 86400`), so a rolling `nowSeconds - N*86400` cutoff
  // would drop the oldest bucket as soon as the wall clock passed midnight
  // — the 7d total would silently shrink to 6 days mid-period. Anchoring
  // on `dayStart - (N-1)*86400` keeps each window covering exactly N daily
  // buckets regardless of intra-day position.
  const dayStart = Math.floor(nowSeconds / SECS_PER_DAY) * SECS_PER_DAY;
  const cutoff24h = dayStart;
  const cutoff7d = dayStart - 6 * SECS_PER_DAY;
  const cutoff30d = dayStart - 29 * SECS_PER_DAY;

  let totalFeesUSD = 0;
  let fees24hUSD = 0;
  let fees7dUSD = 0;
  let fees30dUSD = 0;
  const unpricedSymbolSet = new Set<string>();
  const unpricedSymbols24hSet = new Set<string>();
  let unresolvedCount = 0;
  let unresolvedCount24h = 0;

  for (const s of snapshots) {
    const dayTs = Number(s.timestamp);
    const in24h = dayTs >= cutoff24h;
    const in7d = dayTs >= cutoff7d;
    const in30d = dayTs >= cutoff30d;

    // Pegged side: indexer pre-summed into `feesUsdWei` (18-dp USD-wei).
    const peggedUsd = Number(s.feesUsdWei) / 1e18;
    if (peggedUsd > 0) {
      totalFeesUSD += peggedUsd;
      if (in24h) fees24hUSD += peggedUsd;
      if (in7d) fees7dUSD += peggedUsd;
      if (in30d) fees30dUSD += peggedUsd;
    }

    // FX side: price each non-pegged slot via the oracle rate map.
    for (const { sym, rawAmount, decimals } of iterateFeeSnapshotTokens(s)) {
      if (UNRESOLVED_SYMBOLS.has(sym)) {
        unresolvedCount++;
        if (in24h) unresolvedCount24h++;
        continue;
      }
      if (isUsdPegged(sym)) continue;
      const amount = parseWei(rawAmount, decimals);
      const usd = tokenToUSD(sym, amount, rates);
      if (usd === null) {
        unpricedSymbolSet.add(sym);
        if (in24h) unpricedSymbols24hSet.add(sym);
        continue;
      }
      totalFeesUSD += usd;
      if (in24h) fees24hUSD += usd;
      if (in7d) fees7dUSD += usd;
      if (in30d) fees30dUSD += usd;
    }
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
  };
}

export type PoolFeeEntry = {
  poolId: string;
  chainId: number;
  poolAddress: string;
  totalFeesUSD: number;
  fees24hUSD: number;
  fees7dUSD: number;
  fees30dUSD: number;
  /**
   * Any transfer for this pool used an unknown or unpriced symbol — the
   * all-time total is a lower bound. Window-scoped flags below let the UI
   * apply `≈` per column so an OLD unpriced snapshot doesn't pollute the
   * recent 24h/7d/30d cells.
   */
  unpriced: boolean;
  unpriced24h: boolean;
  unpriced7d: boolean;
  unpriced30d: boolean;
};
