import { describe, expect, it } from "vitest";
import {
  V3_REVENUE_LAUNCH_TIMESTAMP,
  buildCanonicalRevenue,
  type SusdsYieldDailySnapshotRow,
} from "@/lib/canonical-revenue";
import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
} from "@/lib/cdp-borrowing-revenue";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import type { PoolDailyFeeSnapshot } from "@/lib/types";
import { makeNetworkData } from "@/test-utils/network-fixtures";

const NOW_SECONDS = Date.UTC(2026, 5, 12, 12, 0, 0) / 1000;
const DAY = 86_400;

function ts(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 1000;
}

function usdWei(usd: number): string {
  return (BigInt(usd) * BigInt("1000000000000000000")).toString();
}

function feeSnapshot(timestamp: number, usd: number): PoolDailyFeeSnapshot {
  return {
    id: `fee-${timestamp}-${usd}`,
    chainId: 42220,
    poolAddress: "0xpool",
    timestamp: String(timestamp),
    tokens: [],
    tokenSymbols: [],
    tokenDecimals: [],
    amounts: [],
    feesUsdWei: usdWei(usd),
  };
}

function cdpPoint(
  timestamp: number,
  totalFeesUSD: number,
  upfrontFeesUSD = totalFeesUSD,
): CdpBorrowingFeeSeriesPoint {
  return {
    timestamp,
    upfrontFeesUSD,
    accruedInterestUSD: totalFeesUSD - upfrontFeesUSD,
    totalFeesUSD,
    collectedUSD: 0,
  };
}

function reserveSnapshot(
  timestamp: number,
  dailyEarnedYieldUsd: number,
): SusdsYieldDailySnapshotRow {
  return {
    id: `1-susds-${timestamp}`,
    chainId: 1,
    token: "0xsusds",
    timestamp: String(timestamp),
    currentShares: "0",
    costBasisUsdWei: "0",
    realizedYieldUsdWei: "0",
    transferredOutYieldUsdWei: "0",
    redeemedYieldUsdWei: "0",
    currentValueUsdWei: "0",
    unrealizedYieldUsdWei: "0",
    totalEarnedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    dailyEarnedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    dailyRealizedYieldUsdWei: "0",
    dailyUnrealizedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    sharePriceUsdWei: "1000000000000000000",
    sampledAtBlock: "1",
    sampledAtTimestamp: String(timestamp),
  };
}

function reserveYield(
  overrides: Partial<ReserveYieldResponse> = {},
): ReserveYieldResponse {
  return {
    principalUsd: 10_000,
    forecastPrincipalUsd: 10_000,
    earnedYieldUsd: null,
    realizedYieldUsd: null,
    unrealizedYieldUsd: null,
    earnedYieldAsOf: null,
    holdings: [],
    holdingsAsOf: "2026-06-12T00:00:00.000Z",
    grossApyPercent: 3.63,
    fedfundsAsOf: "2026-06-01",
    expenseBps: 15,
    revenueShareBps: 8000,
    netMentoApyPercent: 2.784,
    skySavingsRateApyPercent: 3.5,
    skySavingsRateSource: "onchain-susds-ssr",
    dailyRunRateUsd: 2,
    next30dUsd: 60,
    next365dUsd: 730,
    annualRunRateUsd: 730,
    forecastUnavailableSymbols: [],
    holdingsError: null,
    rateError: null,
    earnedYieldError: null,
    ...overrides,
  };
}

function cdpMarket(
  overrides: Partial<CdpBorrowingRevenueMarket> = {},
): CdpBorrowingRevenueMarket {
  return {
    collateralId: "42220-gbpm",
    chainId: 42220,
    collIndex: 0,
    symbol: "GBPm",
    spYieldSplitBps: 7500,
    activeDebtUSD: 1_000,
    averageAnnualInterestRatePercent: 8,
    annualInterestRunRateUSD: 1_460,
    activeTroveCount: 1,
    totalRevenueUSD: 0,
    upfrontFeesUSD: 0,
    accruedInterestUSD: 0,
    protocolShareUSD: 0,
    collectedUSD: 0,
    activeInterestBracketCount: 1,
    unpricedSymbols: [],
    bracketsTruncated: false,
    ...overrides,
  };
}

describe("buildCanonicalRevenue", () => {
  it("clamps actual periods to v3 launch and uses rolling UTC 30d/7d buckets", () => {
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [
            feeSnapshot(V3_REVENUE_LAUNCH_TIMESTAMP - DAY, 999),
            feeSnapshot(ts("2026-06-01"), 30),
            feeSnapshot(ts("2026-06-07"), 70),
            feeSnapshot(ts("2026-06-12"), 5),
          ],
        }),
      ],
      cdpDailySeries: [
        cdpPoint(ts("2026-06-07"), 25),
        cdpPoint(ts("2026-06-12"), 10),
      ],
      cdpMarkets: [],
      reserveYield: null,
      reserveDailySnapshots: [
        reserveSnapshot(ts("2026-03-04"), 7),
        reserveSnapshot(ts("2026-06-07"), 11),
        reserveSnapshot(ts("2026-06-12"), 3),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.totalUsd).toBe(161);
    expect(result.periods.ytd.totalUsd).toBe(161);
    expect(result.periods.last30d.totalUsd).toBe(154);
    expect(result.periods.last7d.totalUsd).toBe(124);
    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(21);
    expect(result.periods.last30d.reserveYieldUsd).toBe(14);
  });

  it("flags missing reserve history as partial without injecting current AUSD or sUSDS forecast data into actuals", () => {
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({ earnedYieldUsd: 123 }),
      reserveDailySnapshots: [],
      reserveHistoryUnavailable: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(0);
    expect(result.periods.allTimeSinceV3.totalUsd).toBe(12);
    expect(result.periods.allTimeSinceV3.partialReasons).toContain(
      "Reserve earned-yield history is not indexed yet.",
    );
  });

  it("builds reserve, swap, and CDP forecasts from their separate assumptions", () => {
    const completedDays = Array.from(
      { length: 30 },
      (_, index) => ts("2026-05-13") + index * DAY,
    );
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: completedDays.map((timestamp) =>
            feeSnapshot(timestamp, 10),
          ),
        }),
      ],
      cdpDailySeries: completedDays.map((timestamp) => cdpPoint(timestamp, 3)),
      cdpMarkets: [cdpMarket()],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.reserveYieldUsd).toBe(14);
    expect(result.forecasts.next7d.swapFeesUsd).toBe(70);
    expect(result.forecasts.next7d.cdpBorrowingUsd).toBe(28);
    expect(result.forecasts.next7d.totalUsd).toBe(112);
    expect(result.forecasts.next30d.totalUsd).toBe(480);
    expect(result.forecasts.next365d.totalUsd).toBe(5840);
  });

  it("marks swap forecasts unavailable until at least seven completed daily buckets exist", () => {
    const completedDays = Array.from(
      { length: 6 },
      (_, index) => ts("2026-06-06") + index * DAY,
    );
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: completedDays.map((timestamp) =>
            feeSnapshot(timestamp, 10),
          ),
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.swapFeesUsd).toBeNull();
    expect(result.forecasts.next7d.partialReasons).toContain(
      "Swap forecast unavailable: only 6 completed daily buckets loaded.",
    );
  });

  it("averages swap forecasts over loaded completed buckets instead of a fixed thirty-day divisor", () => {
    const completedDays = Array.from(
      { length: 7 },
      (_, index) => ts("2026-06-05") + index * DAY,
    );
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: completedDays.map((timestamp) =>
            feeSnapshot(timestamp, 10),
          ),
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: null,
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.swapFeesUsd).toBe(70);
    expect(result.forecasts.next30d.swapFeesUsd).toBe(300);
    expect(result.forecasts.next365d.swapFeesUsd).toBe(3650);
  });

  it("marks swap forecasts unavailable when swap history failed to load", () => {
    const completedDays = Array.from(
      { length: 30 },
      (_, index) => ts("2026-05-13") + index * DAY,
    );
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: completedDays.map((timestamp) =>
            feeSnapshot(timestamp, 10),
          ),
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      swapFeesFailed: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.swapFeesUsd).toBeNull();
    expect(result.forecasts.next7d.totalUsd).toBe(14);
    expect(result.forecasts.next7d.partialReasons).toContain(
      "Swap forecast unavailable: swap fee history failed to load.",
    );
  });

  it("marks swap forecasts partial when swap history is approximate", () => {
    const completedDays = Array.from(
      { length: 30 },
      (_, index) => ts("2026-05-13") + index * DAY,
    );
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: completedDays.map((timestamp) =>
            feeSnapshot(timestamp, 10),
          ),
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      swapFeesApproximate: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.swapFeesUsd).toBe(70);
    expect(result.forecasts.next7d.partialReasons).toContain(
      "Swap forecast partial: swap fee history is approximate.",
    );
  });

  it("marks CDP forecasts partial when borrowing inputs are approximate", () => {
    const completedDays = Array.from(
      { length: 30 },
      (_, index) => ts("2026-05-13") + index * DAY,
    );
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: completedDays.map((timestamp) => cdpPoint(timestamp, 5)),
      cdpMarkets: [cdpMarket()],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      cdpInputsApproximate: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.cdpBorrowingUsd).toBe(42);
    expect(result.forecasts.next7d.partialReasons).toContain(
      "CDP forecast partial: borrowing revenue inputs are approximate.",
    );
  });

  it("surfaces partial reserve forecast inputs without dropping modeled holdings", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        forecastUnavailableSymbols: ["AUSD"],
        rateError: "AUSD APY source unavailable",
      }),
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.reserveYieldUsd).toBe(14);
    expect(result.forecasts.next7d.partialReasons).toContain(
      "Reserve forecast excludes holdings without APY sources: AUSD.",
    );
    expect(result.forecasts.next7d.partialReasons).toContain(
      "Reserve forecast partial: AUSD APY source unavailable",
    );
  });

  it("marks CDP forecasts unavailable when borrowing revenue inputs fail", () => {
    const completedDays = Array.from(
      { length: 30 },
      (_, index) => ts("2026-05-13") + index * DAY,
    );
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: completedDays.map((timestamp) =>
            feeSnapshot(timestamp, 10),
          ),
        }),
      ],
      cdpDailySeries: completedDays.map((timestamp) => cdpPoint(timestamp, 3)),
      cdpMarkets: [cdpMarket()],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      cdpDailySeriesFailed: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.forecasts.next7d.cdpBorrowingUsd).toBeNull();
    expect(result.forecasts.next7d.totalUsd).toBe(84);
    expect(result.forecasts.next7d.partialReasons).toContain(
      "CDP forecast unavailable: borrowing revenue inputs failed to load.",
    );
  });
});
