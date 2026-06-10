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
  // 0 = no SP yield split → protocol share equals gross, keeping the
  // pre-split expectations in this file intact. Split-specific tests pass
  // the real 7500.
  spYieldSplitBps = 0,
): CdpBorrowingRevenueCollateral {
  return {
    id,
    chainId: 42220,
    collIndex,
    symbol,
    spYieldSplitBps,
  };
}

function makeInstance(
  collateralId: string,
  borrowingFeeCum: string,
  systemDebt = tokenWei(0),
  activeTroveCount = 0,
  shutdown?: { isShutDown: boolean; shutDownAt: string | null },
  borrowingFeeCollectedCum = "0",
): CdpBorrowingRevenueInstance {
  return {
    id: `${collateralId}-instance`,
    collateralId,
    chainId: 42220,
    systemDebt,
    activeTroveCount,
    borrowingFeeCum,
    borrowingFeeCollectedCum,
    isShutDown: shutdown?.isShutDown ?? false,
    shutDownAt: shutdown?.shutDownAt ?? null,
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
  collected = "0",
): CdpBorrowingRevenueDailySnapshot {
  return {
    id: `${collateralId}-${timestamp}`,
    chainId: 42220,
    collateralId,
    instanceId: collateralId,
    timestamp: String(timestamp),
    upfrontFee,
    accruedInterest,
    collected,
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

  it("zeroes the annual run rate for a shut-down market", () => {
    const result = aggregateCdpBorrowingRevenueMarkets({
      collaterals: [makeCollateral("gbp", "GBPm")],
      instances: [
        makeInstance("gbp", tokenWei(0), tokenWei(4_000), 9, {
          isShutDown: true,
          shutDownAt: String(NOW_SECONDS - 1_000),
        }),
      ],
      brackets: [
        makeBracket({
          collateralId: "gbp",
          rate: rateD18(1, 10).toString(),
          totalDebt: tokenWei(1_000),
        }),
      ],
      rates: new Map([["GBPm", 1.25]]) satisfies OracleRateMap,
      nowSeconds: NOW_SECONDS,
    });

    // Forward annual run-rate is zero once the branch has shut down...
    expect(result[0]?.annualInterestRunRateUSD).toBe(0);
    // ...but active debt (a current balance, not a forward projection) stays.
    expect(result[0]?.activeDebtUSD).toBeCloseTo(5_000, 6);
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

  it("caps live interest projection at a shut-down branch's shutDownAt", () => {
    const shutDownAt = NOW_SECONDS - 30 * DAY_SECONDS;
    const collaterals = [makeCollateral("gbp", "GBPm")];
    const brackets = [
      makeBracket({
        collateralId: "gbp",
        totalDebt: tokenWei(3_650),
        rate: rateD18(1, 10).toString(),
        updatedAt: String(shutDownAt - 10 * DAY_SECONDS),
      }),
    ];
    const rates = new Map([["GBPm", 1.25]]) satisfies OracleRateMap;

    const shutDownResult = aggregateCdpBorrowingRevenue({
      collaterals,
      instances: [
        makeInstance("gbp", tokenWei(0), tokenWei(0), 0, {
          isShutDown: true,
          shutDownAt: String(shutDownAt),
        }),
      ],
      brackets,
      rates,
      nowSeconds: NOW_SECONDS,
    });

    // Accrual must stop at shutDownAt: same as projecting only up to shutDownAt.
    const settledAtShutdown = aggregateCdpBorrowingRevenue({
      collaterals,
      instances: [makeInstance("gbp", tokenWei(0), tokenWei(0), 0)],
      brackets,
      rates,
      nowSeconds: shutDownAt,
    });

    // A live branch keeps accruing to now, so it must be strictly larger.
    const liveResult = aggregateCdpBorrowingRevenue({
      collaterals,
      instances: [makeInstance("gbp", tokenWei(0), tokenWei(0), 0)],
      brackets,
      rates,
      nowSeconds: NOW_SECONDS,
    });

    expect(shutDownResult.accruedInterestUSD).toBeCloseTo(
      settledAtShutdown.accruedInterestUSD,
      6,
    );
    expect(shutDownResult.accruedInterestUSD).toBeLessThan(
      liveResult.accruedInterestUSD,
    );
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
      instances: [],
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
      instances: [],
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

describe("SP yield split — protocol share, collected, receivable", () => {
  const RATES: OracleRateMap = new Map([["GBPm", 1.25]]);

  it("splits gross fees into protocol share and SP yield share", () => {
    // 75% SP split on 100 GBPm of upfront fees: protocol keeps 25 GBPm.
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [makeCollateral("gbp", "GBPm", 0, 7_500)],
      instances: [makeInstance("gbp", tokenWei(100))],
      brackets: [],
      rates: RATES,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.totalRevenueUSD).toBeCloseTo(125, 6); // 100 × 1.25
    expect(result.protocolShareUSD).toBeCloseTo(31.25, 6); // 25 × 1.25
    expect(result.spYieldShareUSD).toBeCloseTo(93.75, 6);
  });

  it("prices collected mints and derives the outstanding receivable", () => {
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [makeCollateral("gbp", "GBPm", 0, 7_500)],
      instances: [
        makeInstance(
          "gbp",
          tokenWei(100),
          tokenWei(0),
          0,
          undefined,
          tokenWei(10),
        ),
      ],
      brackets: [],
      rates: RATES,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.collectedUSD).toBeCloseTo(12.5, 6); // 10 × 1.25
    // receivable = protocol share (31.25) − collected (12.5)
    expect(result.receivableUSD).toBeCloseTo(18.75, 6);
  });

  it("clamps the receivable at zero when collected exceeds the live share", () => {
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [makeCollateral("gbp", "GBPm", 0, 7_500)],
      instances: [
        makeInstance(
          "gbp",
          tokenWei(4),
          tokenWei(0),
          0,
          undefined,
          tokenWei(10),
        ),
      ],
      brackets: [],
      rates: RATES,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.receivableUSD).toBe(0);
  });

  it("treats the indexer's -1 split sentinel as no split", () => {
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [makeCollateral("gbp", "GBPm", 0, -1)],
      instances: [makeInstance("gbp", tokenWei(100))],
      brackets: [],
      rates: RATES,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.protocolShareUSD).toBeCloseTo(result.totalRevenueUSD, 6);
  });

  it("scales the snapshot daily series to protocol share and passes collected through unscaled", () => {
    const day0 = NOW_DAY - DAY_SECONDS;
    const result = buildDailyCdpBorrowingFeeSeriesFromSnapshots({
      collaterals: [makeCollateral("gbp", "GBPm", 0, 7_500)],
      instances: [],
      brackets: [],
      dailySnapshots: [
        // Gross 100 upfront + 4 interest; collected mint of 26 (already the
        // on-chain treasury share — must NOT be re-scaled).
        makeDailySnapshot(
          "gbp",
          day0,
          tokenWei(100),
          tokenWei(4),
          tokenWei(26),
        ),
      ],
      rates: RATES,
      nowSeconds: day0 + DAY_SECONDS,
      window: { from: day0, to: day0 + DAY_SECONDS },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.upfrontFeesUSD).toBeCloseTo(31.25, 6); // 25 × 1.25
    expect(result[0]?.accruedInterestUSD).toBeCloseTo(1.25, 6); // 1 × 1.25
    expect(result[0]?.totalFeesUSD).toBeCloseTo(32.5, 6);
    expect(result[0]?.collectedUSD).toBeCloseTo(32.5, 6); // 26 × 1.25
  });

  it("scales the fee-event fallback series by the instance's market split", () => {
    const day0 = NOW_DAY - DAY_SECONDS;
    const instance = makeInstance("gbp", tokenWei(0));
    const result = buildDailyCdpBorrowingFeeSeries({
      collaterals: [makeCollateral("gbp", "GBPm", 0, 7_500)],
      instances: [instance],
      brackets: [],
      feeEvents: [makeFeeEvent(instance.id, tokenWei(100), day0)],
      rates: RATES,
      nowSeconds: day0 + DAY_SECONDS,
      window: { from: day0, to: day0 + DAY_SECONDS },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.upfrontFeesUSD).toBeCloseTo(31.25, 6);
    expect(result[0]?.collectedUSD).toBe(0);
  });
});
