/**
 * Pure computation helpers for the reserves tank visualization.
 * Extracted for testability — all functions are side-effect free.
 */

/**
 * Computes USD-normalized fill percentages for a two-asset pool.
 *
 * Prefers USD-normalized pct when oracle price is available to avoid
 * misleading displays for non-parity pairs (e.g. a balanced KESm/USDm pool
 * has ~130:1 raw token ratio but 50/50 USD value). Falls back to raw token
 * count when oracle data is absent.
 *
 * Edge cases:
 * - Both reserves zero: returns pct0=0, pct1=100 (component should guard against rendering this)
 * - One reserve null (not yet indexed): rawTotal = 0 → pct0=0, pct1=100
 */
export function computeReservePcts(
  r0: number | null,
  r1: number | null,
  usd0: number | null,
  usd1: number | null,
): { pct0: number; pct1: number } {
  const usdTotal = usd0 !== null && usd1 !== null ? usd0 + usd1 : null;
  const rawTotal = r0 !== null && r1 !== null ? r0 + r1 : 0;
  const pct0 =
    usdTotal !== null && usdTotal > 0
      ? (usd0! / usdTotal) * 100
      : rawTotal > 0
        ? (r0! / rawTotal) * 100
        : 0;
  return { pct0, pct1: 100 - pct0 };
}

/**
 * Threshold fill percentages at which priceDifference = rebalanceThreshold.
 *
 * Uses USD-normalized pct where the equilibrium is always 50/50 by
 * construction (both sides have equal USD value when the pool is balanced
 * at oracle price). At critical threshold T = rebalanceThreshold/10000:
 *
 *   threshold0Upper = 100 / (2 − T)   ← too much token0  (x0 at usd1/usd0 = 1−T)
 *   threshold0Lower = 100 / (2 + T)   ← too little token0 (x0 at usd1/usd0 = 1+T)
 *   threshold1Lower = 100 − threshold0Upper  (complements, since pct1 = 100−pct0)
 *   threshold1Upper = 100 − threshold0Lower
 *
 * Derivation: the indexer computes priceDifference from reserveRatio = r1/r0
 * (see indexer-envio/src/priceDifference.ts). At critical:
 *   r1/r0 / oracleRef = 1 ± T → usd1/usd0 = 1 ± T   (oracle cancels via the
 *                                                   USD-price ratio)
 *   x0 = 1 / (1 + usd1/usd0) = 1 / (2 ± T)
 *
 * Returns null when:
 * - usdTotal is null (no oracle → using raw count pct, formula doesn't apply)
 * - rebalanceThreshold is missing or zero
 * - T ≥ 1 (threshold ≥ 10000 bps): threshold0Upper = 100/(2−T) hits 100% at
 *   T=1 and blows past the bar above it. T > 1 is also semantically
 *   nonsense — a pool that tolerates >100% price deviation has no
 *   meaningful rebalance line to draw.
 */
interface ThresholdLines {
  threshold0Lower: number;
  threshold0Upper: number;
  threshold1Lower: number;
  threshold1Upper: number;
}

export function computeThresholdLines(
  rebalanceThreshold: number | null | undefined,
  usdTotal: number | null,
): ThresholdLines | null {
  if (usdTotal === null) return null;
  const T =
    rebalanceThreshold != null && rebalanceThreshold > 0
      ? rebalanceThreshold / 10000
      : null;
  if (T === null || T >= 1) return null;

  const threshold0Upper = 100 / (2 - T);
  const threshold0Lower = 100 / (2 + T);
  return {
    threshold0Upper,
    threshold0Lower,
    threshold1Lower: 100 - threshold0Upper,
    threshold1Upper: 100 - threshold0Lower,
  };
}
