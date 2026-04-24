// ---------------------------------------------------------------------------
// Oracle median-jump computation
//
// Produces the `lastOracleJumpBps` string consumed by metrics-bridge (as the
// `mento_pool_oracle_jump_bps` gauge) and then compared against the pool's
// combined swap fee in the "Oracle Jump Exceeds Swap Fee" alert.
// ---------------------------------------------------------------------------

/** Fixed-point precision used for `lastOracleJumpBps` (4 decimal places,
 * so a 0.5-bps jump on a 10-bps-fee pool renders as "0.5000" and still
 * compares correctly against integer fee sums). */
const JUMP_BPS_PRECISION = 4;

/**
 * Compute the absolute % delta between two `MedianUpdated` prices and format
 * it as a bps string with 4 decimal places.
 *
 * Returns `null` when a jump cannot be computed (no prior median, or the
 * new median is zero — the latter can happen during temporary oracle
 * outages and must not be treated as a 100%-down crash).
 *
 * Uses BigInt arithmetic throughout so a small delta on a 1e24-scaled price
 * does not lose precision by going through float.
 */
export function computeOracleJumpBps(
  prevMedian: bigint,
  newMedian: bigint,
): string | null {
  if (prevMedian <= 0n || newMedian <= 0n) return null;

  const diff =
    newMedian > prevMedian ? newMedian - prevMedian : prevMedian - newMedian;

  // diff / prev × 10_000 gives jump in bps.
  // We want 4 decimal places, so multiply by 10_000 once more before the
  // divide: `diff × 1e8 / prev` is the bps value scaled by 10_000.
  const SCALE = 10n ** BigInt(JUMP_BPS_PRECISION);
  const scaled = (diff * 10_000n * SCALE) / prevMedian;
  const intPart = scaled / SCALE;
  const fracPart = scaled % SCALE;
  return `${intPart}.${fracPart.toString().padStart(JUMP_BPS_PRECISION, "0")}`;
}
