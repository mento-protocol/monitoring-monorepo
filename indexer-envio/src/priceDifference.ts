// ---------------------------------------------------------------------------
// Price difference computation (reserve ratio vs oracle price)
// ---------------------------------------------------------------------------

/** SortedOracles stores prices at 24 decimal precision. */
export const SORTED_ORACLES_DECIMALS = 24;

/** OracleAdapter divides both numerator and denominator by 1e6, converting
 * SortedOracles' 24dp precision to 18dp. Multiply by this factor to restore
 * the original 24dp scale when reading from getRebalancingState(). */
export const ORACLE_ADAPTER_SCALE_FACTOR = 1_000_000n;

/**
 * Normalize an amount to 18 decimal precision regardless of source token decimals.
 * Handles dec < 18 (scale up), dec > 18 (scale down), dec === 18 (no-op).
 */
export function normalizeTo18(amount: bigint, decimals: number): bigint {
  if (decimals === 18) return amount;
  if (decimals < 18) return amount * 10n ** BigInt(18 - decimals);
  return amount / 10n ** BigInt(decimals - 18);
}

/**
 * Convert an on-chain ERC20 decimals scaling factor (e.g. 1000000n for 6dp,
 * 10^18 for 18dp) to a plain decimals count. Returns null if the value is not
 * a valid power of 10 (rejects unexpected/corrupt on-chain values).
 */
export function scalingFactorToDecimals(scaling: bigint): number | null {
  if (scaling <= 0n) return null;
  let d = 0;
  let n = scaling;
  while (n > 1n && n % 10n === 0n) {
    n /= 10n;
    d += 1;
  }
  return n === 1n ? d : null; // reject non-10^n values
}

/**
 * Computes priceDifference in basis points (bps) from reserves and oracle price,
 * matching the on-chain FPMM formula: |reservePrice - oraclePrice| / oraclePrice.
 *
 * CORRECTED: The FPMM contract computes reservePrice as token1/token0:
 *   reservePrice = (reserve1 * tpm1) / (reserve0 * tpm0)
 *   where tpm = tokenPrecisionMultiplier = 10^(18 - decimals)
 *
 * After normalization to 18dp this simplifies to norm1/norm0.
 *
 * Oracle price is stored in **feed direction** (24dp SortedOracles rate).
 * The invertRateFeed flag determines whether the oracle needs to be inverted.
 *
 * Returns 0n when oracle price or reserves are missing/zero.
 */
export function computePriceDifference(pool: {
  reserves0: bigint;
  reserves1: bigint;
  oraclePrice: bigint;
  invertRateFeed: boolean;
  token0Decimals: number;
  token1Decimals: number;
}): bigint {
  if (pool.oraclePrice === 0n || pool.reserves0 === 0n || pool.reserves1 === 0n)
    return 0n;

  const SCALE = 10n ** 24n;
  // Normalize reserves to 18 decimals before computing ratio.
  const norm0 = normalizeTo18(pool.reserves0, pool.token0Decimals);
  const norm1 = normalizeTo18(pool.reserves1, pool.token1Decimals);
  // Guard against normalization flooring to zero (possible when decimals > 18).
  if (norm0 === 0n || norm1 === 0n) return 0n;

  // CORRECTED: The FPMM contract computes reservePrice as token1/token0 (norm1/norm0).
  const reserveRatio = (norm1 * SCALE) / norm0;

  // oraclePrice is stored in feed direction (raw SortedOracles rate at 24dp).
  // When invertRateFeed is true, the contract compares reserves against 1/feedRate.
  const oracleRef = pool.invertRateFeed
    ? (SCALE * SCALE) / pool.oraclePrice
    : pool.oraclePrice;

  // priceDiff in bps: |reserveRatio - oracleRef| * 10000 / oracleRef
  const diff =
    reserveRatio > oracleRef
      ? reserveRatio - oracleRef
      : oracleRef - reserveRatio;
  return (diff * 10000n) / oracleRef;
}

/**
 * Rebalance effectiveness ratio: how much of the pre-rebalance deviation was
 * closed by a single rebalance. Range:
 *   `1.0`  → deviation fully collapsed (pool ≈ oracle after)
 *   `0.5`  → halved
 *   `0.0`  → no reduction
 *   `< 0`  → rebalance moved price FURTHER from oracle (legitimate + alertable)
 *
 * Returns `null` when `before <= 0n` (no meaningful ratio — zero pre-deviation).
 * Callers decide the sentinel string based on their consumer contract:
 *
 *   - `Pool.lastEffectivenessRatio` uses `"-1"` to match
 *     `DEFAULT_ORACLE_FIELDS.lastEffectivenessRatio` — metrics-bridge skips the
 *     Prometheus publish on that exact string, keeping the alert's
 *     `avg_over_time` window clean of no-data points.
 *   - `RebalanceEvent.effectivenessRatio` uses `"0.0000"` to preserve the
 *     historical numeric-only contract — dashboard consumers
 *     (`EffectivenessChart`, rebalance history table) render via
 *     `Number(x) * 100`, so emitting `"-1"` there would misreport degenerate
 *     rebalances as `-100%` effective.
 *
 * Emitted string uses `toFixed(4)` to match `RebalanceEvent.effectivenessRatio`
 * stringification.
 */
export function computeEffectivenessRatio(
  priceDifferenceBefore: bigint,
  priceDifferenceAfter: bigint,
): string | null {
  if (priceDifferenceBefore <= 0n) return null;
  const improvement = priceDifferenceBefore - priceDifferenceAfter;
  return (Number(improvement) / Number(priceDifferenceBefore)).toFixed(4);
}
