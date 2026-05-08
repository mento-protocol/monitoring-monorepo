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

/** Shared inputs for `reservePriceVsOracleRef`, `computePriceDifference`,
 * and `pickActiveThreshold`. Identical fields to the FPMM `getRebalancingState`
 * contract reads but kept structural (no `Pool` type dependency) so callers
 * can pass synthetic objects in tests. */
type RatioInputs = {
  reserves0: bigint;
  reserves1: bigint;
  oraclePrice: bigint;
  invertRateFeed: boolean;
  token0Decimals: number;
  token1Decimals: number;
};

const SCALE_24DP = 10n ** 24n;

/** Compute the (reserveRatio, oracleRef) pair both `computePriceDifference`
 * and `pickActiveThreshold` need. Returns `null` for any zero-reserve or
 * zero-oracle input — caller decides what the absent value means. The FPMM
 * contract computes reservePrice as `(reserve1 * tpm1) / (reserve0 * tpm0)`
 * where `tpm = 10^(18 - decimals)`; after normalizing to 18dp this is
 * `norm1/norm0`. `invertRateFeed` flips the oracle to `1/feedRate`. */
function reservePriceVsOracleRef(
  pool: RatioInputs,
): { reserveRatio: bigint; oracleRef: bigint } | null {
  if (pool.oraclePrice === 0n || pool.reserves0 === 0n || pool.reserves1 === 0n)
    return null;
  const norm0 = normalizeTo18(pool.reserves0, pool.token0Decimals);
  const norm1 = normalizeTo18(pool.reserves1, pool.token1Decimals);
  // Normalization can floor to zero when decimals > 18.
  if (norm0 === 0n || norm1 === 0n) return null;
  const reserveRatio = (norm1 * SCALE_24DP) / norm0;
  const oracleRef = pool.invertRateFeed
    ? (SCALE_24DP * SCALE_24DP) / pool.oraclePrice
    : pool.oraclePrice;
  return { reserveRatio, oracleRef };
}

/**
 * Computes priceDifference in basis points (bps) from reserves and oracle price,
 * matching the on-chain FPMM formula: |reservePrice - oraclePrice| / oraclePrice.
 *
 * Oracle price is stored in **feed direction** (24dp SortedOracles rate).
 * The invertRateFeed flag determines whether the oracle needs to be inverted.
 *
 * Returns 0n when oracle price or reserves are missing/zero.
 */
export function computePriceDifference(pool: RatioInputs): bigint {
  const r = reservePriceVsOracleRef(pool);
  if (!r) return 0n;
  const diff =
    r.reserveRatio > r.oracleRef
      ? r.reserveRatio - r.oracleRef
      : r.oracleRef - r.reserveRatio;
  return (diff * 10000n) / r.oracleRef;
}

/**
 * Direction-correct active threshold: matches the on-chain
 * `getRebalancingState` selection of `rebalanceThreshold` based on
 * `reservePriceAboveOraclePrice`. `>` picks `above`, `<=` picks `below`
 * (mirrors contract: equality resolves as `below`, which we follow exactly
 * so derived values match `getRebalancingState` to the bps). Falls back to
 * `above` when reserves are degenerate so an uninitialized pool doesn't
 * silently bias toward `below`.
 */
export function pickActiveThreshold(
  pool: RatioInputs,
  thresholds: { above: number; below: number },
): number {
  const r = reservePriceVsOracleRef(pool);
  if (!r) return thresholds.above;
  return r.reserveRatio > r.oracleRef ? thresholds.above : thresholds.below;
}

/**
 * Resolved rebalance state shared by the entity-derived path and the
 * `getRebalancingState` RPC fallback path. Downstream consumers
 * (state-sync handlers) treat both sources identically.
 */
export type ResolvedRebalanceState = {
  oraclePrice: bigint;
  rebalanceThreshold: number;
  priceDifference: bigint;
};

/**
 * Apply the OracleAdapter SCALE_FACTOR + invertRateFeed flip to a raw
 * `getRebalancingState` RPC result, producing the `ResolvedRebalanceState`
 * scalar. Kept here next to `tryDeriveRebalanceState` so both code paths
 * agree on the OracleAdapter convention without re-encoding it in handlers.
 */
export function scaleRpcRebalanceState(
  rs: {
    oraclePriceNumerator: bigint;
    oraclePriceDenominator: bigint;
    rebalanceThreshold: number;
    priceDifference: bigint;
  },
  existing: { invertRateFeed: boolean } | undefined,
): ResolvedRebalanceState {
  const isInverted = existing?.invertRateFeed ?? false;
  return {
    oraclePrice: isInverted
      ? rs.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rs.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR,
    rebalanceThreshold: rs.rebalanceThreshold,
    priceDifference: rs.priceDifference,
  };
}

/**
 * Derive `getRebalancingState`'s relevant outputs from the entity store.
 * Returns `null` when the required inputs aren't yet populated; caller
 * falls back to RPC.
 *
 * Required inputs:
 *   - `oraclePrice > 0`: at least one `MedianUpdated` for the rate feed
 *     has been indexed (or factory's `getRebalancingState` seed succeeded).
 *   - At least one of `rebalanceThresholdAbove` / `rebalanceThresholdBelow`
 *     is > 0: factory's `rebalanceThresholdsEffect` seed succeeded, or a
 *     `RebalanceThresholdUpdated` event has been seen.
 *
 * `reservesOverride` lets UpdateReserves pass the event's new reserves
 * (the contract's `getRebalancingState` reads post-event state); Rebalanced
 * passes nothing because the prior 2× UpdateReserves handlers in the same
 * tx have already written post-rebalance reserves to the entity.
 */
export function tryDeriveRebalanceState(
  pool: RatioInputs & {
    rebalanceThresholdAbove: number;
    rebalanceThresholdBelow: number;
  },
  reservesOverride?: { reserve0: bigint; reserve1: bigint },
): ResolvedRebalanceState | null {
  if (pool.oraclePrice <= 0n) return null;
  if (pool.rebalanceThresholdAbove <= 0 && pool.rebalanceThresholdBelow <= 0) {
    return null;
  }
  const reserves = reservesOverride
    ? {
        reserves0: reservesOverride.reserve0,
        reserves1: reservesOverride.reserve1,
      }
    : { reserves0: pool.reserves0, reserves1: pool.reserves1 };
  const poolForCalc = {
    ...pool,
    ...reserves,
  };
  const priceDifference = computePriceDifference(poolForCalc);
  const rebalanceThreshold = pickActiveThreshold(poolForCalc, {
    above: pool.rebalanceThresholdAbove,
    below: pool.rebalanceThresholdBelow,
  });
  return {
    oraclePrice: pool.oraclePrice,
    rebalanceThreshold,
    priceDifference,
  };
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
