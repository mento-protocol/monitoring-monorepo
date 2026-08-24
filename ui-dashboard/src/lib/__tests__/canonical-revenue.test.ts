import { describe, expect, it } from "vitest";
import {
  V3_REVENUE_LAUNCH_TIMESTAMP,
  buildCanonicalRevenue,
  type StethYieldDailySnapshotRow,
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
const UNVERIFIABLE_SUSDS_SNAPSHOT_SOURCE_REASON =
  "Reserve sUSDS earned-yield actuals unavailable: current reserve holdings classification failed and no SusdsYieldDailySnapshot source exists.";
const UNAVAILABLE_SUSDS_SIGNAL_SOURCE_REASON =
  "Reserve sUSDS earned-yield actuals unavailable: the current sUSDS yield signal is unavailable and no SusdsYieldDailySnapshot source exists.";

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
  totalEarnedYieldUsd = dailyEarnedYieldUsd,
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
    totalEarnedYieldUsdWei: usdWei(totalEarnedYieldUsd),
    dailyEarnedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    dailyRealizedYieldUsdWei: "0",
    dailyUnrealizedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    sharePriceUsdWei: "1000000000000000000",
    sampledAtBlock: "1",
    sampledAtTimestamp: String(timestamp),
  };
}

function stethReserveSnapshot(
  timestamp: number,
  wallet: string,
  dailyEarnedYieldAmount: number,
  totalEarnedYieldAmount = dailyEarnedYieldAmount,
  overrides: Partial<StethYieldDailySnapshotRow> = {},
): StethYieldDailySnapshotRow {
  return {
    id: `1-steth-${wallet}-${timestamp}`,
    chainId: 1,
    token: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    wallet,
    timestamp: String(timestamp),
    balanceAmount: "0",
    principalAmount: "0",
    realizedYieldAmount: "0",
    transferredOutYieldAmount: "0",
    unrealizedYieldAmount: "0",
    totalEarnedYieldAmount: usdWei(totalEarnedYieldAmount),
    dailyEarnedYieldAmount: usdWei(dailyEarnedYieldAmount),
    dailyRealizedYieldAmount: "0",
    dailyUnrealizedYieldAmount: usdWei(dailyEarnedYieldAmount),
    sampledAtBlock: "1",
    sampledAtTimestamp: String(timestamp),
    ...overrides,
  };
}

function stethHolding(
  overrides: Partial<ReserveYieldResponse["holdings"][number]> = {},
): ReserveYieldResponse["holdings"][number] {
  return {
    id: "ethereum-steth-reserve-safe",
    chain: "ethereum",
    assetSymbol: "stETH",
    sourceType: "safe",
    sourceLabel: "Reserve Safe",
    identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
    custodianType: "self-custody",
    principalUsd: 419_495.97,
    balance: 251.59825779325257,
    hasTokenBalance: true,
    earnedYieldUsd: null,
    apyPercent: 2.95,
    dailyRunRateUsd: 33.91,
    next30dUsd: 1_017.31,
    next365dUsd: 12_375.13,
    annualRunRateUsd: 12_375.13,
    yieldModel:
      "Lido stETH APR forecast; stETH mark-to-market changes are not counted as earned revenue",
    ...overrides,
  };
}

function reserveYield(
  overrides: Partial<ReserveYieldResponse> = {},
): ReserveYieldResponse {
  return {
    principalUsd: 10_000,
    forecastPrincipalUsd: 10_000,
    earnedYieldUsd: null,
    susdsEarnedYieldUsd: null,
    susdsYieldSignalUnavailable: false,
    susdsSnapshotSourceRequired: false,
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
    reserveCurrentHoldingsClassificationFailed: false,
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
        reserveSnapshot(ts("2026-03-04"), 7, 7),
        reserveSnapshot(ts("2026-06-07"), 11, 18),
        reserveSnapshot(ts("2026-06-12"), 3, 21),
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
      reserveYield: reserveYield({ susdsEarnedYieldUsd: 123 }),
      reserveDailySnapshots: [],
      reserveHistoryUnavailable: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.totalUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.availableTotalUsd).toBe(12);
    expect(result.periods.allTimeSinceV3.partialReasons).toContain(
      "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.",
    );
  });

  it("flags empty reserve snapshots as partial when the current reserve ledger has yield", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({ susdsEarnedYieldUsd: 123 }),
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.totalUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.partialReasons).toContain(
      "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.",
    );
  });

  it("flags empty reserve snapshots as partial when current stETH actuals are pending", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        earnedYieldError:
          "stETH earned-yield actuals pending: no indexed wallet snapshot rows yet.",
        holdings: [stethHolding()],
      }),
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.totalUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.partialReasons).toContain(
      "Reserve earned-yield actuals partial: stETH earned-yield actuals pending: no indexed wallet snapshot rows yet.",
    );
  });

  it("does not treat stETH rows as an sUSDS actual source", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          {
            ...stethHolding(),
            assetSymbol: "sUSDS",
            principalUsd: 2_000,
          },
        ],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(
          ts("2026-06-12"),
          "0xd0697f70e79476195b742d5afab14be50f98cc1e",
          1,
        ),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.partialReasons).toContain(
      "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.",
    );
  });

  it("marks stETH-only rows unavailable when current holdings classification fails", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [stethHolding({ identifier: wallet })],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1, 1),
      ],
      reserveCurrentHoldingsClassificationFailed: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.partialReasons).toContain(
      UNVERIFIABLE_SUSDS_SNAPSHOT_SOURCE_REASON,
    );
  });

  it("marks stETH-only rows unavailable when the sUSDS signal cannot be established", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        earnedYieldUsd: 25,
        holdings: [stethHolding({ identifier: wallet })],
        susdsYieldSignalUnavailable: true,
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1, 25),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.partialReasons).toContain(
      UNAVAILABLE_SUSDS_SIGNAL_SOURCE_REASON,
    );
  });

  it("keeps loaded sUSDS rows available when the current signal is unavailable", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({ susdsYieldSignalUnavailable: true }),
      reserveDailySnapshots: [reserveSnapshot(ts("2026-06-12"), 5)],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(5);
    expect(result.partialReasons).not.toContain(
      UNAVAILABLE_SUSDS_SIGNAL_SOURCE_REASON,
    );
  });

  it("keeps stETH-only rows available after a clean zero sUSDS signal", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        earnedYieldUsd: 25,
        holdings: [stethHolding({ identifier: wallet })],
        susdsSnapshotSourceRequired: false,
        susdsYieldSignalUnavailable: false,
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1, 25),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).not.toBeNull();
    expect(result.partialReasons).not.toContain(
      UNAVAILABLE_SUSDS_SIGNAL_SOURCE_REASON,
    );
  });

  it("fails closed for a legacy response without the sUSDS signal field", () => {
    const legacy: Partial<ReserveYieldResponse> = { ...reserveYield() };
    delete legacy.susdsYieldSignalUnavailable;
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: legacy as ReserveYieldResponse,
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.partialReasons).toContain(
      UNAVAILABLE_SUSDS_SIGNAL_SOURCE_REASON,
    );
  });

  it("prioritizes a reserve history failure over an unverifiable sUSDS source", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      reserveHistoryFailed: true,
      reserveCurrentHoldingsClassificationFailed: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.partialReasons).toContain(
      "Reserve earned-yield history failed to load.",
    );
    expect(result.partialReasons).not.toContain(
      UNVERIFIABLE_SUSDS_SNAPSHOT_SOURCE_REASON,
    );
  });

  it("keeps the known current sUSDS missing-source reason", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({ susdsEarnedYieldUsd: 123 }),
      reserveDailySnapshots: [],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.partialReasons).toContain(
      "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.",
    );
    expect(result.partialReasons).not.toContain(
      UNVERIFIABLE_SUSDS_SNAPSHOT_SOURCE_REASON,
    );
  });

  it("fails closed for a known current sUSDS row without a usable holding", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        susdsSnapshotSourceRequired: true,
        holdings: [],
        susdsEarnedYieldUsd: 0,
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1, 25),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.partialReasons).toContain(
      "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.",
    );
  });

  it("keeps loaded sUSDS actuals available when current holdings classification fails", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [reserveSnapshot(ts("2026-06-12"), 5)],
      reserveCurrentHoldingsClassificationFailed: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(5);
    expect(result.partialReasons).not.toContain(
      UNVERIFIABLE_SUSDS_SNAPSHOT_SOURCE_REASON,
    );
  });

  it.each([
    ["rate", { rateError: "FRED FEDFUNDS: HTTP 503" }],
    [
      "stETH earned-yield",
      {
        earnedYieldError:
          "stETH earned-yield actuals pending: no indexed wallet snapshot rows yet.",
      },
    ],
  ])(
    "does not infer an unverifiable sUSDS source from a %s error",
    (_source, error) => {
      const result = buildCanonicalRevenue({
        networkData: [],
        cdpDailySeries: [],
        cdpMarkets: [],
        reserveYield: reserveYield(error),
        reserveDailySnapshots: [],
        nowSeconds: NOW_SECONDS,
      });

      expect(result.partialReasons).not.toContain(
        UNVERIFIABLE_SUSDS_SNAPSHOT_SOURCE_REASON,
      );
    },
  );

  it("does not use combined stETH yield as an sUSDS signal", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        earnedYieldUsd: 123,
        holdings: [stethHolding()],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(
          ts("2026-06-12"),
          "0xd0697f70e79476195b742d5afab14be50f98cc1e",
          1,
        ),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.partialReasons).not.toContain(
      "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.",
    );
  });

  it("treats an unpriced current sUSDS balance as an sUSDS signal", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          stethHolding({
            assetSymbol: "sUSDS",
            principalUsd: 0,
            balance: 2_000,
            earnedYieldUsd: null,
          }),
        ],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(
          ts("2026-06-12"),
          "0xd0697f70e79476195b742d5afab14be50f98cc1e",
          1,
        ),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.partialReasons).toContain(
      "Reserve sUSDS earned-yield actuals unavailable: no SusdsYieldDailySnapshot source exists for current sUSDS holdings or earned signal.",
    );
  });

  it("prices stETH reserve history with the current wallet USD/token rate", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          stethHolding({
            identifier: wallet,
            principalUsd: 4_000,
            balance: 2,
          }),
        ],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-11"), wallet, 1, 1),
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1, 2),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(4_000);
    expect(result.partialReasons).not.toContain(
      "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
    );
  });

  it("keeps mixed active and zero-exposure stETH wallet history complete", () => {
    const activeWallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const dormantWallet = "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          stethHolding({
            identifier: activeWallet,
            principalUsd: 4_000,
            balance: 2,
          }),
        ],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-11"), activeWallet, 1, 1, {
          balanceAmount: usdWei(2),
          principalAmount: usdWei(1),
        }),
        stethReserveSnapshot(ts("2026-06-11"), dormantWallet, 0),
        stethReserveSnapshot(ts("2026-06-12"), activeWallet, 1, 2, {
          balanceAmount: usdWei(2),
          principalAmount: usdWei(1),
        }),
        stethReserveSnapshot(ts("2026-06-12"), dormantWallet, 0),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(4_000);
    expect(result.periods.allTimeSinceV3.totalUsd).toBe(4_000);
    expect(result.partialReasons).not.toContain(
      "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
    );
  });

  it("subtracts prior stETH yield and resets the baseline at zero exposure", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const activeExposure = {
      balanceAmount: usdWei(2),
      principalAmount: usdWei(1),
    };
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          stethHolding({ identifier: wallet, principalUsd: 4_000, balance: 2 }),
        ],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-10"), wallet, 1, 1, activeExposure),
        stethReserveSnapshot(ts("2026-06-11"), wallet, 0),
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1, 1, activeExposure),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(
      result.dailySeries.find((point) => point.timestamp === ts("2026-06-11"))
        ?.reserveYieldUsd,
    ).toBe(-2_000);
    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(2_000);
    expect(result.partialReasons).not.toContain(
      "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
    );
  });

  it("nets an internal tracked-wallet stETH transfer without partial pricing", () => {
    const sender = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const receiver = "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1";
    const yieldExposure = {
      balanceAmount: usdWei(2),
      principalAmount: usdWei(1),
    };
    const principalOnlyExposure = {
      balanceAmount: usdWei(1),
      principalAmount: usdWei(1),
    };
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          stethHolding({ identifier: sender, principalUsd: 2_000, balance: 1 }),
          stethHolding({
            identifier: receiver,
            principalUsd: 2_000,
            balance: 1,
          }),
        ],
      }),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-10"), sender, 1, 1, yieldExposure),
        stethReserveSnapshot(ts("2026-06-11"), sender, 0),
        stethReserveSnapshot(ts("2026-06-11"), receiver, 1, 1, yieldExposure),
        stethReserveSnapshot(
          ts("2026-06-12"),
          sender,
          0,
          0,
          principalOnlyExposure,
        ),
        stethReserveSnapshot(ts("2026-06-12"), receiver, 0, 1, yieldExposure),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(
      result.dailySeries.find((point) => point.timestamp === ts("2026-06-11"))
        ?.reserveYieldUsd,
    ).toBe(0);
    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(2_000);
    expect(result.partialReasons).not.toContain(
      "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
    );
  });

  it("keeps earlier unpriced stETH history partial after a zero-exposure row", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [
        stethReserveSnapshot(ts("2026-06-11"), wallet, 0, 1, {
          balanceAmount: usdWei(1),
          principalAmount: usdWei(1),
        }),
        stethReserveSnapshot(ts("2026-06-12"), wallet, 0),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.partialReasons).toContain(
      "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
    );
  });

  it.each([
    ["balance", { balanceAmount: "1" }],
    ["principal", { principalAmount: "1" }],
    ["cumulative yield dust", { totalEarnedYieldAmount: "1" }],
    ["daily yield dust", { dailyEarnedYieldAmount: "1" }],
  ])(
    "keeps an unpriced stETH row partial when its %s is nonzero",
    (_label, overrides) => {
      const wallet = "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1";
      const result = buildCanonicalRevenue({
        networkData: [],
        cdpDailySeries: [],
        cdpMarkets: [],
        reserveYield: reserveYield(),
        reserveDailySnapshots: [
          stethReserveSnapshot(ts("2026-06-12"), wallet, 0, 0, overrides),
        ],
        nowSeconds: NOW_SECONDS,
      });

      expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
      expect(result.partialReasons).toContain(
        "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
      );
    },
  );

  it.each([
    ["balance", { balanceAmount: "not-wei" }],
    ["principal", { principalAmount: "not-wei" }],
    ["cumulative yield", { totalEarnedYieldAmount: "not-wei" }],
    ["daily yield", { dailyEarnedYieldAmount: "not-wei" }],
    ["blank balance", { balanceAmount: "" }],
    ["whitespace-only balance", { balanceAmount: "  " }],
    ["non-decimal balance", { balanceAmount: "0x0" }],
  ])(
    "keeps an unpriced stETH row partial when its %s is malformed",
    (_label, overrides) => {
      const wallet = "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1";
      const result = buildCanonicalRevenue({
        networkData: [],
        cdpDailySeries: [],
        cdpMarkets: [],
        reserveYield: reserveYield(),
        reserveDailySnapshots: [
          stethReserveSnapshot(ts("2026-06-12"), wallet, 0, 0, overrides),
        ],
        nowSeconds: NOW_SECONDS,
      });

      expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
      expect(result.partialReasons).toContain(
        "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
      );
    },
  );

  it("marks stETH reserve history partial when current wallet pricing is missing", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          stethHolding({
            identifier: wallet,
            hasTokenBalance: false,
            balance: 0,
          }),
        ],
      }),
      reserveDailySnapshots: [
        reserveSnapshot(ts("2026-06-12"), 5),
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.totalUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.availableTotalUsd).toBe(12);
    expect(result.partialReasons).toContain(
      "Reserve stETH earned-yield history is unavailable: current stETH USD/token pricing is missing.",
    );
  });

  it("uses cumulative reserve-yield deltas so compression reduces period totals", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [
        reserveSnapshot(ts("2026-06-10"), 100, 100),
        reserveSnapshot(ts("2026-06-11"), 0, 50),
        reserveSnapshot(ts("2026-06-12"), 0, 50),
      ],
      nowSeconds: NOW_SECONDS,
    });

    const compressionDay = result.dailySeries.find(
      (point) => point.timestamp === ts("2026-06-11"),
    );
    expect(compressionDay?.reserveYieldUsd).toBe(-50);
    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBe(50);
  });

  it("marks reserve actuals unavailable when current reserve yield fails before snapshots exist", () => {
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: null,
      reserveDailySnapshots: [],
      reserveYieldFailed: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.totalUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.availableTotalUsd).toBe(12);
    expect(result.partialReasons).toContain(
      "Reserve earned-yield actuals unavailable: current reserve yield failed to load before any snapshots were indexed.",
    );
  });

  it("marks reserve history stale instead of zero-filling after the latest snapshot", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [reserveSnapshot(ts("2026-06-10"), 45)],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.availableTotalUsd).toBe(45);
    expect(
      result.dailySeries.find((point) => point.timestamp === ts("2026-06-10"))
        ?.reserveYieldUsd,
    ).toBe(45);
    expect(
      result.dailySeries.find((point) => point.timestamp === ts("2026-06-11"))
        ?.reserveYieldUsd,
    ).toBeNull();
    expect(result.partialReasons).toContain(
      "Reserve earned-yield history is stale; latest snapshot is Jun 10, 2026.",
    );
  });

  it("marks reserve history stale when any active reserve source is stale", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield({
        holdings: [
          stethHolding({
            identifier: wallet,
            principalUsd: 2_000,
            balance: 1,
          }),
        ],
      }),
      reserveDailySnapshots: [
        reserveSnapshot(ts("2026-06-10"), 5),
        stethReserveSnapshot(ts("2026-06-12"), wallet, 1),
      ],
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.reserveYieldUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.availableTotalUsd).toBe(5);
    expect(
      result.dailySeries.find((point) => point.timestamp === ts("2026-06-10"))
        ?.reserveYieldUsd,
    ).toBe(5);
    expect(
      result.dailySeries.find((point) => point.timestamp === ts("2026-06-12"))
        ?.reserveYieldUsd,
    ).toBeNull();
    expect(result.partialReasons).toContain(
      "Reserve earned-yield history is stale; latest snapshot is Jun 10, 2026.",
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

  it("excludes pre-launch swap fee buckets from trailing forecasts", () => {
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [
            feeSnapshot(ts("2026-02-28"), 100),
            feeSnapshot(ts("2026-03-01"), 100),
            feeSnapshot(ts("2026-03-02"), 100),
            feeSnapshot(ts("2026-03-03"), 10),
            feeSnapshot(ts("2026-03-04"), 10),
            feeSnapshot(ts("2026-03-05"), 10),
          ],
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      nowSeconds: ts("2026-03-06") + 12 * 60 * 60,
    });

    expect(result.forecasts.next7d.swapFeesUsd).toBeNull();
    expect(result.forecasts.next7d.partialReasons).toContain(
      "Swap forecast unavailable: only 3 completed daily buckets loaded.",
    );
  });

  it("excludes pre-launch CDP upfront fee buckets from trailing forecasts", () => {
    const result = buildCanonicalRevenue({
      networkData: [],
      cdpDailySeries: [
        cdpPoint(ts("2026-03-02"), 1_000, 1_000),
        cdpPoint(ts("2026-03-04"), 10, 10),
      ],
      cdpMarkets: [],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [],
      nowSeconds: ts("2026-03-05") + 12 * 60 * 60,
    });

    expect(result.forecasts.next7d.cdpBorrowingUsd).toBe(70);
    expect(result.forecasts.next30d.cdpBorrowingUsd).toBe(300);
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
    expect(result.streams.swap.actualPartialReasons).toContain(
      "Swap fee history is approximate.",
    );
    expect(result.streams.swap.forecastPartialReasons).toContain(
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
      "Reserve forecast excludes holdings without annual-rate sources: AUSD.",
    );
    expect(result.streams.reserve.partialReasons).toContain(
      "Reserve forecast excludes holdings without annual-rate sources: AUSD.",
    );
    expect(result.streams.reserve.actualPartialReasons).toEqual([]);
    expect(result.streams.reserve.forecastPartialReasons).toContain(
      "Reserve forecast excludes holdings without annual-rate sources: AUSD.",
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

  it("marks CDP actuals unavailable when daily history fails instead of reporting zero", () => {
    const result = buildCanonicalRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      cdpDailySeries: [],
      cdpMarkets: [cdpMarket({ protocolShareUSD: 46.875 })],
      reserveYield: reserveYield(),
      reserveDailySnapshots: [reserveSnapshot(ts("2026-06-12"), 5)],
      cdpDailySeriesFailed: true,
      nowSeconds: NOW_SECONDS,
    });

    expect(result.periods.allTimeSinceV3.cdpBorrowingUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.totalUsd).toBeNull();
    expect(result.periods.allTimeSinceV3.availableTotalUsd).toBe(17);
    expect(result.streams.cdp.actualUsd).toBeNull();
    expect(
      result.dailySeries.some((point) => point.cdpBorrowingUsd === null),
    ).toBe(true);
    expect(result.partialReasons).toContain(
      "CDP borrowing revenue history failed to load.",
    );
  });
});
