/**
 * Per-pool aggregation over `PoolDailyFeeSnapshot` rows. Replaces the older
 * `aggregateProtocolFeesByPool` (raw transfers) for the /revenue leaderboard.
 *
 * Hybrid USD pricing matches the indexer:
 * - USD-pegged tokens (cUSD, USDC, USDm, …) are pre-summed indexer-side into
 *   `feesUsdWei` (18-dp USD-wei BigInt).
 * - FX tokens (EURm, GBPm, BRLm, …) carry their amounts in the parallel
 *   `tokens[]` / `tokenSymbols[]` / `tokenDecimals[]` / `amounts[]` arrays
 *   and are priced dashboard-side via the live oracle rate map.
 *
 * Window inclusion is full-day (`dayStartTimestamp >= now - windowSeconds`).
 * No partial-day weighting — keeps the leaderboard aligned with how users
 * read "last 24h", and matches the chain-level fee-over-time chart's UTC-day
 * buckets.
 */

import { parseWei } from "./format";
import { normalizePoolIdForChain } from "./pool-id";
import { isUsdPegged, tokenToUSD, type OracleRateMap } from "./tokens";
import type { PoolDailyFeeSnapshot } from "./types";
import {
  UNRESOLVED_SYMBOLS,
  iterateFeeSnapshotTokens,
  type PoolFeeEntry,
} from "./protocol-fees";

const SECS_PER_DAY = 86_400;

export function aggregateFeeSnapshotsByPool(
  snapshots: ReadonlyArray<PoolDailyFeeSnapshot>,
  rates: OracleRateMap,
  chainId: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PoolFeeEntry[] {
  // Day-aligned cutoffs — snapshot timestamps are UTC-midnight buckets, so
  // anchoring on `dayStart - (N-1)*86400` keeps each window covering exactly
  // N daily buckets regardless of intra-day position. A rolling
  // `nowSeconds - N*86400` cutoff would drop the oldest bucket as soon as
  // the clock passed midnight (silent undercount mid-period).
  const dayStart = Math.floor(nowSeconds / SECS_PER_DAY) * SECS_PER_DAY;
  const cutoff24h = dayStart;
  const cutoff7d = dayStart - 6 * SECS_PER_DAY;
  const cutoff30d = dayStart - 29 * SECS_PER_DAY;
  const byPool = new Map<string, PoolFeeEntry>();

  for (const s of snapshots) {
    const poolAddress = s.poolAddress.toLowerCase();
    const poolId = normalizePoolIdForChain(poolAddress, chainId);
    let entry = byPool.get(poolId);
    if (!entry) {
      entry = {
        poolId,
        chainId,
        poolAddress,
        totalFeesUSD: 0,
        fees24hUSD: 0,
        fees7dUSD: 0,
        fees30dUSD: 0,
        unpriced: false,
        unpriced24h: false,
        unpriced7d: false,
        unpriced30d: false,
      };
      byPool.set(poolId, entry);
    }

    const dayTs = Number(s.timestamp);
    const in24h = dayTs >= cutoff24h;
    const in7d = dayTs >= cutoff7d;
    const in30d = dayTs >= cutoff30d;

    // Pegged side: indexer pre-summed into `feesUsdWei` (18-dp USD-wei).
    // BigInt in wei → JS number USD via `/ 1e18`. Realistic fee totals stay
    // well below `Number.MAX_SAFE_INTEGER`.
    const peggedUsd = Number(s.feesUsdWei) / 1e18;
    if (peggedUsd > 0) {
      entry.totalFeesUSD += peggedUsd;
      if (in24h) entry.fees24hUSD += peggedUsd;
      if (in7d) entry.fees7dUSD += peggedUsd;
      if (in30d) entry.fees30dUSD += peggedUsd;
    }

    // FX side: price each non-pegged slot via the oracle rate map. Skip
    // pegged symbols (already counted in `feesUsdWei`) and indexer
    // placeholders (UNRESOLVED_SYMBOLS). Bound on `tokenSymbols` since
    // that's what the body reads first. When a slot is unpriced, mark
    // `unpriced` for the all-time column AND scope the per-window flags to
    // the windows whose cutoffs include this snapshot's day — so an old
    // unpriced day doesn't pollute the recent 24h/7d/30d cells.
    for (const { sym, rawAmount, decimals } of iterateFeeSnapshotTokens(s)) {
      if (UNRESOLVED_SYMBOLS.has(sym)) {
        markUnpriced(entry, in24h, in7d, in30d);
        continue;
      }
      if (isUsdPegged(sym)) continue;
      const amount = parseWei(rawAmount, decimals);
      const usd = tokenToUSD(sym, amount, rates);
      if (usd === null) {
        markUnpriced(entry, in24h, in7d, in30d);
        continue;
      }
      entry.totalFeesUSD += usd;
      if (in24h) entry.fees24hUSD += usd;
      if (in7d) entry.fees7dUSD += usd;
      if (in30d) entry.fees30dUSD += usd;
    }
  }

  return Array.from(byPool.values());
}

function markUnpriced(
  entry: PoolFeeEntry,
  in24h: boolean,
  in7d: boolean,
  in30d: boolean,
): void {
  entry.unpriced = true;
  if (in24h) entry.unpriced24h = true;
  if (in7d) entry.unpriced7d = true;
  if (in30d) entry.unpriced30d = true;
}
