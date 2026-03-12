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
 * - Both reserves zero: returns 0%/0% (empty pool, not 50%/50%)
 * - One reserve null (not yet indexed): rawTotal = 0 → 0%/100%
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
 *   threshold0Upper = (1+T)/(2+T) × 100   ← too much token0
 *   threshold0Lower = (1-T)/(2-T) × 100   ← too little token0
 *   threshold1Lower = 100 − threshold0Upper  (complements, since pct1 = 100−pct0)
 *   threshold1Upper = 100 − threshold0Lower
 *
 * Derivation: constant product pool at critical → r0/r1 = P_pool×(1±T).
 *   In USD terms: usd0/usd1 = 1±T → x_usd = (1±T)/(2±T). Oracle price cancels.
 *
 * Returns null when:
 * - usdTotal is null (no oracle → using raw count pct, formula doesn't apply)
 * - rebalanceThreshold is missing or zero
 * - T ≥ 1 (threshold ≥ 10000 bps — degenerate; (2−T) would be ≤ 1, safe band collapses)
 */
export interface ThresholdLines {
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

  const threshold0Upper = ((1 + T) / (2 + T)) * 100;
  const threshold0Lower = ((1 - T) / (2 - T)) * 100;
  return {
    threshold0Upper,
    threshold0Lower,
    threshold1Lower: 100 - threshold0Upper,
    threshold1Upper: 100 - threshold0Lower,
  };
}
