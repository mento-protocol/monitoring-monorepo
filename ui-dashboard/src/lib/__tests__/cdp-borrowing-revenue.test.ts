import { describe, expect, it } from "vitest";
import {
  aggregateCdpBorrowingRevenue,
  aggregateCdpBorrowingRevenueMarkets,
  buildDailyCdpBorrowingFeeSeries,
  buildDailyCdpBorrowingFeeSeriesFromSnapshots,
} from "../cdp-borrowing-revenue";
import type {
  CdpBorrowingFeeEvent,
  CdpBorrowingRevenueBracket,
  CdpBorrowingRevenueCollateral,
  CdpBorrowingRevenueDailySnapshot,
  CdpBorrowingRevenueInstance,
} from "../cdp-borrowing-revenue";
import type { OracleRateMap } from "../tokens";

const D18 = BigInt(10) ** BigInt(18);
const YEAR_SECONDS = BigInt(31_536_000);
const DAY_SECONDS = 86_400;
const NOW_SECONDS = 1_700_000_000;
const NOW_DAY = Math.floor(NOW_SECONDS / DAY_SECONDS) * DAY_SECONDS;

const tokenWei = (wholeTokens: number): string =>
  (BigInt(wholeTokens) * D18).toString();

const rateD18 = (numerator: number, denominator: number): bigint =>
  (BigInt(numerator) * D18) / BigInt(denominator);

function makeCollateral(
  id: string,
  symbol: string,
  collIndex = 0,
): CdpBorrowingRevenueCollateral {
  return {
    id,
    chainId: 42220,
    collIndex,
    symbol,
  };
}

function makeInstance(
  collateralId: string,
  borrowingFeeCum: string,
  systemDebt = tokenWei(0),
  activeTroveCount = 0,
): CdpBorrowingRevenueInstance {
  return {
    id: `${collateralId}-instance`,
    collateralId,
    chainId: 42220,
    systemDebt,
    activeTroveCount,
    borrowingFeeCum,
  };
}

function makeBracket(
  overrides: Partial<CdpBorrowingRevenueBracket> = {},
): CdpBorrowingRevenueBracket {
  const collateralId = overrides.collateralId ?? "gbp";
  const rate = overrides.rate ?? rateD18(1, 10).toString();
  const totalDebt = overrides.totalDebt ?? tokenWei(1_000);
  const sumDebtTimesRateD36 =
    overrides.sumDebtTimesRateD36 ??
    (BigInt(totalDebt) * BigInt(rate)).toString();

  return {
    id: `${collateralId}-${rate}`,
    collateralId,
    rate,
    totalDebt,
    sumDebtTimesRateD36,
    pendingDebtTimesOneYearD36: overrides.pendingDebtTimesOneYearD36 ?? "0",
    updatedAt: overrides.updatedAt ?? String(NOW_SECONDS),
  };
}

function makeFeeEvent(
  instanceId: string,
  debtIncreaseFromUpfrontFee: string,
  timestamp = NOW_SECONDS,
): CdpBorrowingFeeEvent {
  return {
    id: `${instanceId}-${timestamp}`,
    instanceId,
    debtIncreaseFromUpfrontFee,
    timestamp: String(timestamp),
  };
}

function makeDailySnapshot(
  collateralId: string,
  timestamp: number,
  upfrontFee: string,
  accruedInterest: string,
): CdpBorrowingRevenueDailySnapshot {
  return {
    id: `${collateralId}-${timestamp}`,
    chainId: 42220,
    collateralId,
    instanceId: collateralId,
    timestamp: String(timestamp),
    upfrontFee,
    accruedInterest,
  };
}

describe("aggregateCdpBorrowingRevenue", () => {
  it("prices upfront fees and live accrued interest by debt-token symbol", () => {
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [
        makeCollateral("gbp", "GBPm"),
        makeCollateral("chf", "CHFm"),
      ],
      instances: [
        makeInstance("gbp", tokenWei(100), tokenWei(1_000), 3),
        makeInstance("chf", tokenWei(50)),
      ],
      brackets: [
        makeBracket({
          collateralId: "gbp",
          updatedAt: String(NOW_SECONDS - Number(YEAR_SECONDS / BigInt(2))),
        }),
      ],
      rates: new Map([
        ["GBPm", 1.25],
        ["CHFm", 1.1],
      ]) satisfies OracleRateMap,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.upfrontFeesUSD).toBeCloseTo(180, 6);
    expect(result.accruedInterestUSD).toBeCloseTo(62.5, 6);
    expect(result.totalRevenueUSD).toBeCloseTo(242.5, 6);
    expect(result.marketCount).toBe(2);
    expect(result.activeInterestBracketCount).toBe(1);
    expect(result.unpricedSymbols).toEqual([]);
  });

  it("builds market rows sorted by total borrowing revenue", () => {
    const result = aggregateCdpBorrowingRevenueMarkets({
      collaterals: [
        makeCollateral("gbp", "GBPm", 0),
        makeCollateral("chf", "CHFm", 1),
      ],
      instances: [
        makeInstance("gbp", tokenWei(100), tokenWei(1_000), 3),
        makeInstance("chf", tokenWei(50)),
      ],
      brackets: [
        makeBracket({
          collateralId: "gbp",
          updatedAt: String(NOW_SECONDS - Number(YEAR_SECONDS / BigInt(2))),
        }),
      ],
      rates: new Map([
        ["GBPm", 1.25],
        ["CHFm", 1.1],
      ]) satisfies OracleRateMap,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.map((row) => row.symbol)).toEqual(["GBPm", "CHFm"]);
    expect(result[0]?.activeDebtUSD).toBeCloseTo(1_250, 6);
    expect(result[0]?.averageAnnualInterestRatePercent).toBeCloseTo(10, 6);
    expect(result[0]?.annualInterestRunRateUSD).toBeCloseTo(125, 6);
    expect(result[0]?.activeTroveCount).toBe(3);
    expect(result[0]?.upfrontFeesUSD).toBeCloseTo(125, 6);
    expect(result[0]?.accruedInterestUSD).toBeCloseTo(62.5, 6);
    expect(result[0]?.totalRevenueUSD).toBeCloseTo(187.5, 6);
    expect(result[1]?.totalRevenueUSD).toBeCloseTo(55, 6);
  });

  it("computes debt-weighted market APR and annual interest run rate", () => {
    const result = aggregateCdpBorrowingRevenueMarkets({
      collaterals: [makeCollateral("gbp", "GBPm")],
      instances: [makeInstance("gbp", tokenWei(0), tokenWei(4_000), 9)],
      brackets: [
        makeBracket({
          collateralId: "gbp",
          rate: rateD18(1, 10).toString(),
          totalDebt: tokenWei(1_000),
        }),
        makeBracket({
          collateralId: "gbp",
          rate: rateD18(1, 20).toString(),
          totalDebt: tokenWei(3_000),
        }),
      ],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: NOW_SECONDS,
    });

    expect(result[0]?.activeDebtUSD).toBeCloseTo(5_000, 6);
    expect(result[0]?.averageAnnualInterestRatePercent).toBeCloseTo(6.25, 6);
    expect(result[0]?.annualInterestRunRateUSD).toBeCloseTo(312.5, 6);
    expect(result[0]?.activeTroveCount).toBe(9);
  });

  it("includes previously accumulated bracket interest before live accrual", () => {
    const pendingInterestWei = BigInt(tokenWei(10));
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [makeCollateral("gbp", "GBPm")],
      instances: [],
      brackets: [
        makeBracket({
          collateralId: "gbp",
          totalDebt: tokenWei(0),
          sumDebtTimesRateD36: "0",
          pendingDebtTimesOneYearD36: (
            pendingInterestWei *
            YEAR_SECONDS *
            D18
          ).toString(),
          updatedAt: String(NOW_SECONDS - 100),
        }),
      ],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.accruedInterestUSD).toBeCloseTo(12.5, 6);
    expect(result.activeInterestBracketCount).toBe(0);
  });

  it("tracks unpriced debt symbols instead of silently treating them as USD", () => {
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [makeCollateral("jpy", "JPYm")],
      instances: [makeInstance("jpy", tokenWei(1_000))],
      brackets: [],
      rates: new Map() satisfies OracleRateMap,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.totalRevenueUSD).toBe(0);
    expect(result.upfrontFeesUSD).toBe(0);
    expect(result.unpricedSymbols).toEqual(["JPYm"]);
  });

  it("does not accrue negative interest when a bracket timestamp is in the future", () => {
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [makeCollateral("gbp", "GBPm")],
      instances: [],
      brackets: [
        makeBracket({
          collateralId: "gbp",
          updatedAt: String(NOW_SECONDS + 10_000),
        }),
      ],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.accruedInterestUSD).toBe(0);
    expect(result.activeInterestBracketCount).toBe(1);
  });
});

describe("buildDailyCdpBorrowingFeeSeries", () => {
  it("buckets upfront borrowing fees by trove-operation day", () => {
    const collateral = makeCollateral("gbp", "GBPm");
    const instance = makeInstance("gbp", tokenWei(0));
    const result = buildDailyCdpBorrowingFeeSeries({
      collaterals: [collateral],
      instances: [instance],
      brackets: [],
      feeEvents: [
        makeFeeEvent(instance.id, tokenWei(10), NOW_DAY + 60),
        makeFeeEvent(instance.id, tokenWei(5), NOW_DAY + 120),
      ],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: NOW_DAY + DAY_SECONDS,
      window: { from: NOW_DAY, to: NOW_DAY + DAY_SECONDS },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.timestamp).toBe(NOW_DAY);
    expect(result[0]?.upfrontFeesUSD).toBeCloseTo(18.75, 6);
    expect(result[0]?.accruedInterestUSD).toBe(0);
    expect(result[0]?.totalFeesUSD).toBeCloseTo(18.75, 6);
  });

  it("splits live interest accrual across daily buckets", () => {
    const day0 = NOW_DAY - 2 * DAY_SECONDS;
    const collateral = makeCollateral("gbp", "GBPm");
    const instance = makeInstance("gbp", tokenWei(0));
    const result = buildDailyCdpBorrowingFeeSeries({
      collaterals: [collateral],
      instances: [instance],
      brackets: [
        makeBracket({
          collateralId: collateral.id,
          totalDebt: tokenWei(3_650),
          rate: rateD18(1, 10).toString(),
          updatedAt: String(day0),
        }),
      ],
      feeEvents: [],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: day0 + 2 * DAY_SECONDS,
      window: { from: day0, to: day0 + 2 * DAY_SECONDS },
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.timestamp).toBe(day0);
    expect(result[0]?.accruedInterestUSD).toBeCloseTo(1.25, 6);
    expect(result[1]?.timestamp).toBe(day0 + DAY_SECONDS);
    expect(result[1]?.accruedInterestUSD).toBeCloseTo(1.25, 6);
    expect(
      result.reduce((sum, point) => sum + point.totalFeesUSD, 0),
    ).toBeCloseTo(2.5, 6);
  });

  it("places previously accumulated interest in the bracket update bucket", () => {
    const pendingInterestWei = BigInt(tokenWei(10));
    const collateral = makeCollateral("gbp", "GBPm");
    const result = buildDailyCdpBorrowingFeeSeries({
      collaterals: [collateral],
      instances: [],
      brackets: [
        makeBracket({
          collateralId: collateral.id,
          totalDebt: tokenWei(0),
          sumDebtTimesRateD36: "0",
          pendingDebtTimesOneYearD36: (
            pendingInterestWei *
            YEAR_SECONDS *
            D18
          ).toString(),
          updatedAt: String(NOW_DAY + 60),
        }),
      ],
      feeEvents: [],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: NOW_DAY + DAY_SECONDS,
      window: { from: NOW_DAY, to: NOW_DAY + DAY_SECONDS },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.accruedInterestUSD).toBeCloseTo(12.5, 6);
    expect(result[0]?.totalFeesUSD).toBeCloseTo(12.5, 6);
  });
});

describe("buildDailyCdpBorrowingFeeSeriesFromSnapshots", () => {
  it("uses stored daily borrowing revenue snapshots for upfront fees and interest", () => {
    const collateral = makeCollateral("gbp", "GBPm");
    const result = buildDailyCdpBorrowingFeeSeriesFromSnapshots({
      collaterals: [collateral],
      brackets: [],
      dailySnapshots: [
        makeDailySnapshot(collateral.id, NOW_DAY, tokenWei(10), tokenWei(2)),
        makeDailySnapshot(
          collateral.id,
          NOW_DAY + DAY_SECONDS,
          tokenWei(5),
          tokenWei(1),
        ),
      ],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: NOW_DAY + 2 * DAY_SECONDS,
      window: { from: NOW_DAY, to: NOW_DAY + 2 * DAY_SECONDS },
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.upfrontFeesUSD).toBeCloseTo(12.5, 6);
    expect(result[0]?.accruedInterestUSD).toBeCloseTo(2.5, 6);
    expect(result[0]?.totalFeesUSD).toBeCloseTo(15, 6);
    expect(result[1]?.totalFeesUSD).toBeCloseTo(7.5, 6);
  });

  it("adds only live interest since the bracket's last snapshot settlement", () => {
    const day0 = NOW_DAY - DAY_SECONDS;
    const collateral = makeCollateral("gbp", "GBPm");
    const result = buildDailyCdpBorrowingFeeSeriesFromSnapshots({
      collaterals: [collateral],
      brackets: [
        makeBracket({
          collateralId: collateral.id,
          totalDebt: tokenWei(3_650),
          rate: rateD18(1, 10).toString(),
          pendingDebtTimesOneYearD36: (
            BigInt(tokenWei(100)) *
            YEAR_SECONDS *
            D18
          ).toString(),
          updatedAt: String(day0),
        }),
      ],
      dailySnapshots: [
        makeDailySnapshot(collateral.id, day0, tokenWei(0), tokenWei(4)),
      ],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: day0 + DAY_SECONDS,
      window: { from: day0, to: day0 + DAY_SECONDS },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.accruedInterestUSD).toBeCloseTo(6.25, 6);
    expect(result[0]?.totalFeesUSD).toBeCloseTo(6.25, 6);
  });
});
