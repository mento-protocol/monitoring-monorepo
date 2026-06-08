export const BPS = 10_000n;
export const D18 = 10n ** 18n;
export const ONE_YEAR_SECONDS = 31_536_000n;
const MAX_GRAPHQL_INT = 2_147_483_647n;
const RATE_BRACKET_PRECISION = 10n ** 15n; // 0.1% in D18 rate units.

export const toBpsFromD18 = (value: bigint): number =>
  Number((value * BPS) / D18);

export const floorInterestRateBracket = (rate: bigint): bigint =>
  (rate / RATE_BRACKET_PRECISION) * RATE_BRACKET_PRECISION;

export const computeCollateralRatioBps = ({
  coll,
  debt,
  collateralDebtPriceD18,
}: {
  coll: bigint;
  debt: bigint;
  collateralDebtPriceD18: bigint;
}): number => {
  if (debt <= 0n || collateralDebtPriceD18 <= 0n) return -1;
  const ratioBps = (coll * collateralDebtPriceD18 * BPS) / (debt * D18);
  return Number(ratioBps > MAX_GRAPHQL_INT ? MAX_GRAPHQL_INT : ratioBps);
};

export const computeTroveIcrBps = ({
  coll,
  debt,
  price,
}: {
  coll: bigint;
  debt: bigint;
  price: bigint | null;
}): number =>
  price == null
    ? -1
    : computeCollateralRatioBps({
        coll,
        debt,
        collateralDebtPriceD18: price,
      });

export const addSigned = (base: bigint, delta: bigint): bigint => {
  const next = base + delta;
  return next > 0n ? next : 0n;
};

export const negativeToPositive = (value: bigint): bigint =>
  value < 0n ? -value : value;

/**
 * Compute the trove's debt and collateral immediately after a `TroveOperation`
 * applies, given the pre-operation values and every signed/unsigned delta the
 * ABI exposes. Used to snapshot before/after on `TroveOperationEvent` rows so
 * the UI can render `5,000 → 4,000 (−1,000)` without waiting for the
 * subsequent `TroveUpdated`.
 *
 * Inputs mirror the ABI's `TroveOperation` payload exactly:
 *   debtAfter = debtBefore + debtChange + upfrontFee + debtFromRedist
 *   collAfter = collBefore + collChange + collFromRedist
 *
 * The redist terms are critical when pending redistribution materializes on
 * this op; omitting them lets the snapshot drift from `TroveUpdated._debt`.
 *
 * For batch-membership ops (SET_BATCH_MANAGER / REMOVE_FROM_BATCH /
 * OPEN_AND_JOIN_BATCH), the matching debt-truth event is `BatchUpdated`
 * (not `TroveUpdated`), which derives per-trove debt via
 * `batch.debt * shares / totalShares`. That share-rounding can introduce
 * tiny per-trove drift vs. this arithmetic — acceptable here because the
 * UI rounds to display precision well above any wei-level discrepancy.
 */
export const computeTroveOperationSnapshot = (params: {
  debtBefore: bigint;
  collBefore: bigint;
  debtChange: bigint;
  debtIncreaseFromUpfrontFee: bigint;
  debtIncreaseFromRedist: bigint;
  collChange: bigint;
  collIncreaseFromRedist: bigint;
}): { debtAfter: bigint; collAfter: bigint } => {
  const debtAfter =
    params.debtBefore +
    params.debtChange +
    params.debtIncreaseFromUpfrontFee +
    params.debtIncreaseFromRedist;
  const collAfter =
    params.collBefore + params.collChange + params.collIncreaseFromRedist;
  // Floor at 0 — a CLOSE_TROVE that fully repays can produce mathematical
  // zero, and we never want a negative on-chain quantity to leak out via
  // signed-bigint underflow if a future ABI revision violates invariants.
  return {
    debtAfter: debtAfter > 0n ? debtAfter : 0n,
    collAfter: collAfter > 0n ? collAfter : 0n,
  };
};

export const accrueDebtTimesRate = ({
  totalDebt,
  sumDebtTimesRateD36,
  pendingDebtTimesOneYearD36,
  updatedAt,
  now,
}: {
  totalDebt: bigint;
  sumDebtTimesRateD36: bigint;
  pendingDebtTimesOneYearD36: bigint;
  updatedAt: bigint;
  now: bigint;
}): {
  totalDebt: bigint;
  sumDebtTimesRateD36: bigint;
  pendingDebtTimesOneYearD36: bigint;
  updatedAt: bigint;
} => {
  if (now <= updatedAt) {
    return {
      totalDebt,
      sumDebtTimesRateD36,
      pendingDebtTimesOneYearD36,
      updatedAt,
    };
  }
  return {
    totalDebt,
    sumDebtTimesRateD36,
    pendingDebtTimesOneYearD36:
      pendingDebtTimesOneYearD36 + sumDebtTimesRateD36 * (now - updatedAt),
    updatedAt: now,
  };
};

export const debtTimesRateD36 = (debt: bigint, rate: bigint): bigint =>
  debt * rate;
