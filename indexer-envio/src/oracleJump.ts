/** Fixed-point precision used for `lastOracleJumpBps` (4 decimal places,
 * so a 0.5-bps jump on a 10-bps-fee pool renders as "0.5000" and still
 * compares correctly against integer fee sums). */
const JUMP_BPS_PRECISION = 4;
const JUMP_BPS_SCALE = 10n ** BigInt(JUMP_BPS_PRECISION);
// diff / prev × 10_000 gives jump in bps; multiply by SCALE again before
// the divide to keep `JUMP_BPS_PRECISION` decimals.
const JUMP_BPS_NUMERATOR_SCALE = 10_000n * JUMP_BPS_SCALE;

/** Lineage state the SortedOracles MedianUpdated handler reads from
 * `existing` and writes back as the `Pool` row's median-lineage half. */
export interface MedianLineageState {
  lastMedianPrice: bigint;
  lastMedianAt: bigint;
  prevMedianPrice: bigint;
  prevMedianAt: bigint;
  lastOracleJumpBps: string;
  lastOracleJumpAt: bigint;
  /** True iff the most recent MedianUpdated emitted a non-zero value.
   * False during a zero-median outage even though `lastMedianPrice` is
   * frozen at the prior non-zero value. */
  medianLive: boolean;
}

/**
 * Compute the next median-lineage state for a `MedianUpdated` event.
 *
 * Three cases the handler cares about:
 *   - Zero new median (transient outage) → freeze every field; the alert
 *     stays anchored to the last real prior median.
 *   - First real median (no prior) → advance `lastMedian*` only;
 *     `prev*` and `lastOracleJump*` stay 0 because no jump can be computed.
 *   - Subsequent real median → capture `existing.lastMedian*` into
 *     `prev*` BEFORE overwriting, and record the jump.
 *
 * Pure function so the handler stays a thin event glue layer and the
 * three-case lineage invariant can be tested as a pure function.
 */
export function computeMedianLineageNext(
  existing: MedianLineageState,
  oraclePrice: bigint,
  blockTimestamp: bigint,
): MedianLineageState {
  const jumpBps = computeOracleJumpBps(existing.lastMedianPrice, oraclePrice);
  const isTransition = jumpBps !== null;
  const isLiveMedian = oraclePrice > 0n;
  return {
    lastMedianPrice: isLiveMedian ? oraclePrice : existing.lastMedianPrice,
    lastMedianAt: isLiveMedian ? blockTimestamp : existing.lastMedianAt,
    prevMedianPrice: isTransition
      ? existing.lastMedianPrice
      : existing.prevMedianPrice,
    prevMedianAt: isTransition ? existing.lastMedianAt : existing.prevMedianAt,
    lastOracleJumpBps: jumpBps ?? existing.lastOracleJumpBps,
    lastOracleJumpAt: isTransition ? blockTimestamp : existing.lastOracleJumpAt,
    medianLive: isLiveMedian,
  };
}

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

  const scaled = (diff * JUMP_BPS_NUMERATOR_SCALE) / prevMedian;
  const intPart = scaled / JUMP_BPS_SCALE;
  const fracPart = scaled % JUMP_BPS_SCALE;
  return `${intPart}.${fracPart.toString().padStart(JUMP_BPS_PRECISION, "0")}`;
}
