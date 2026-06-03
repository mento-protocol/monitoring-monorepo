import { describe, expect, it } from "vitest";
import { aggregateCdpBorrowingRevenue } from "../cdp-borrowing-revenue";
import type {
  CdpBorrowingRevenueBracket,
  CdpBorrowingRevenueCollateral,
  CdpBorrowingRevenueInstance,
} from "../cdp-borrowing-revenue";
import type { OracleRateMap } from "../tokens";

const D18 = BigInt(10) ** BigInt(18);
const YEAR_SECONDS = BigInt(31_536_000);
const NOW_SECONDS = 1_700_000_000;

const tokenWei = (wholeTokens: number): string =>
  (BigInt(wholeTokens) * D18).toString();

const rateD18 = (numerator: number, denominator: number): bigint =>
  (BigInt(numerator) * D18) / BigInt(denominator);

function makeCollateral(
  id: string,
  symbol: string,
): CdpBorrowingRevenueCollateral {
  return {
    id,
    chainId: 42220,
    collIndex: 0,
    symbol,
  };
}

function makeInstance(
  collateralId: string,
  borrowingFeeCum: string,
): CdpBorrowingRevenueInstance {
  return {
    id: `${collateralId}-instance`,
    collateralId,
    chainId: 42220,
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

describe("aggregateCdpBorrowingRevenue", () => {
  it("prices upfront fees and live accrued interest by debt-token symbol", () => {
    const result = aggregateCdpBorrowingRevenue({
      collaterals: [
        makeCollateral("gbp", "GBPm"),
        makeCollateral("chf", "CHFm"),
      ],
      instances: [
        makeInstance("gbp", tokenWei(100)),
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
