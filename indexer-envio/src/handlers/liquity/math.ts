export const BPS = 10_000n;
export const D18 = 10n ** 18n;
export const ONE_YEAR_SECONDS = 31_536_000n;
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
  return Number((coll * collateralDebtPriceD18 * BPS) / (debt * D18));
};

export const addSigned = (base: bigint, delta: bigint): bigint => {
  const next = base + delta;
  return next > 0n ? next : 0n;
};

export const negativeToPositive = (value: bigint): bigint =>
  value < 0n ? -value : value;

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
