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
 * Rebalance effectiveness: fraction of the pre-rebalance gap-to-boundary
 * that a single rebalance closed. `1.0` = landed exactly on the boundary;
 * `>1` = overshoot past the boundary; `<0` = made deviation worse; `0.0000`
 * = genuinely zero-effective (before == after above threshold — a legit
 * control-loop miss the dashboard must still surface).
 *
 * `priceDifference` is an unsigned magnitude and the boundary is symmetric
 * around the oracle, so min-side and max-side breaches are handled without
 * sign tracking. `toFixed(4)` matches the `RebalanceEvent.effectivenessRatio`
 * stringification contract.
 *
 * Returns `null` when the rebalance isn't a meaningful breach-close — i.e.
 * `before <= 0`, `threshold <= 0` (sentinel before the indexer has read the
 * on-chain value), or `before <= threshold` (pool was already in-band).
 * Callers pick the string sentinel:
 *   - `Pool.lastEffectivenessRatio` → `"-1"` (metrics-bridge skips publish)
 *   - `RebalanceEvent.effectivenessRatio` → `""` (empty string: falsy in
 *     dashboard boolean checks, distinct from a real `"0.0000"` 0%-effective
 *     rebalance so the UI can render `—` without hiding genuine misses)
 */
export function computeEffectivenessRatio(
  priceDifferenceBefore: bigint,
  priceDifferenceAfter: bigint,
  rebalanceThreshold: number,
): string | null {
  if (priceDifferenceBefore <= 0n) return null;
  const thresholdBig = BigInt(rebalanceThreshold);
  if (thresholdBig <= 0n) return null;
  const gap = priceDifferenceBefore - thresholdBig;
  if (gap <= 0n) return null;
  const improvement = priceDifferenceBefore - priceDifferenceAfter;
  return (Number(improvement) / Number(gap)).toFixed(4);
}

/**
 * Bundles the effectiveness computation + both sentinel renderings for a
 * rebalance event. Shared by FPMM.Rebalanced and VirtualPool.Rebalanced.
 */
export function buildRebalanceOutcome(input: {
  priceDifferenceBefore: bigint;
  priceDifferenceAfter: bigint;
  rebalanceThreshold: number;
}): {
  improvement: bigint;
  lastEffectivenessRatio: string;
  eventEffectivenessRatio: string;
} {
  const raw = computeEffectivenessRatio(
    input.priceDifferenceBefore,
    input.priceDifferenceAfter,
    input.rebalanceThreshold,
  );
  return {
    improvement: input.priceDifferenceBefore - input.priceDifferenceAfter,
    lastEffectivenessRatio: raw ?? "-1",
    eventEffectivenessRatio: raw ?? "",
  };
}
