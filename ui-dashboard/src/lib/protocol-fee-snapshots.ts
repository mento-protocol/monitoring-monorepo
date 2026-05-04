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
import type { PoolFeeEntry } from "./protocol-fees";

const SECS_PER_DAY = 86_400;

export function aggregateFeeSnapshotsByPool(
  snapshots: ReadonlyArray<PoolDailyFeeSnapshot>,
  rates: OracleRateMap,
  chainId: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PoolFeeEntry[] {
  const cutoff24h = nowSeconds - SECS_PER_DAY;
  const cutoff7d = nowSeconds - 7 * SECS_PER_DAY;
  const cutoff30d = nowSeconds - 30 * SECS_PER_DAY;
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
        // Per-window unpriced flags retained on the type for backwards
        // compatibility with `aggregateProtocolFeesByPool`. The new
        // leaderboard only reads `unpriced`; we mirror it across windows so
        // legacy callers don't see a stale `false`.
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
    // pegged symbols (already counted in `feesUsdWei`) and UNKNOWN slots.
    for (let i = 0; i < s.tokens.length; i++) {
      const sym = s.tokenSymbols[i];
      if (sym === "UNKNOWN") {
        entry.unpriced = true;
        continue;
      }
      if (isUsdPegged(sym)) continue;
      const amount = parseWei(s.amounts[i], s.tokenDecimals[i]);
      const usd = tokenToUSD(sym, amount, rates);
      if (usd === null) {
        entry.unpriced = true;
        continue;
      }
      entry.totalFeesUSD += usd;
      if (in24h) entry.fees24hUSD += usd;
      if (in7d) entry.fees7dUSD += usd;
      if (in30d) entry.fees30dUSD += usd;
    }
  }

  // Mirror `unpriced` across the deprecated per-window flags so any legacy
  // reader stays consistent. The leaderboard component itself only reads
  // `unpriced`.
  for (const entry of byPool.values()) {
    if (entry.unpriced) {
      entry.unpriced24h = true;
      entry.unpriced7d = true;
      entry.unpriced30d = true;
    }
  }

  return Array.from(byPool.values());
}
