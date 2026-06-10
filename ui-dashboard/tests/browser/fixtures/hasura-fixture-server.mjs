#!/usr/bin/env node
import http from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3211" },
  },
});

const port = Number(values.port);
const DAY_SECONDS = 86_400;
const FIXED_1 = "1000000000000000000000000";

const ADDRESSES = {
  celoPool: "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
  monadPool: "143-0xb0a0264ce6847f101b76ba36a4a3083ba489f501",
  celoUsdm: "0x765de816845861e75a25fca122bb6898b8b1282a",
  celoUsdc: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
  celoGbpm: "0xccf663b1ff11028f0b19058d0f7b674004a40746",
  celoChfm: "0xb55a79f398e759e43c95b979163f30ec87ee131d",
  celoJpym: "0xc45ecf20f3cd864b32d9794d6f76814ae8892e20",
  celoBrlm: "0x0000000000000000000000000000000000000b71",
  celoTroveManagerGbpm: "0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
  celoStabilityPoolGbpm: "0x2d5d7e2767c5493610cae84e0ab7f9d2cce8c1a5",
  monadAusd: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
  monadUsdm: "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115",
  lp: "0x1111111111111111111111111111111111111111",
  trader: "0x2222222222222222222222222222222222222222",
  recipient: "0x3333333333333333333333333333333333333333",
  troveOwnerA: "0x4444444444444444444444444444444444444444",
  troveOwnerB: "0x5555555555555555555555555555555555555555",
};

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function poolFixture({
  id,
  chainId,
  token0,
  token1,
  token0Decimals,
  token1Decimals,
  reserves0,
  reserves1,
  notionalVolume0,
  notionalVolume1,
}) {
  const now = nowSeconds();
  return {
    id,
    chainId,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    tokenDecimalsKnown: true,
    source: "fpmm_factory",
    wrappedExchangeId: null,
    createdAtBlock: "1000",
    createdAtTimestamp: String(now - 90 * DAY_SECONDS),
    updatedAtBlock: "1500",
    updatedAtTimestamp: String(now - 60),
    healthStatus: "OK",
    oracleOk: true,
    oraclePrice: FIXED_1,
    oracleTimestamp: String(now - 60),
    oracleTxHash:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    oracleExpiry: "3600",
    oracleNumReporters: 5,
    referenceRateFeedID: "",
    priceDifference: "0",
    degenerateReserves: false,
    rebalanceThreshold: 100,
    rebalanceThresholdAbove: 100,
    rebalanceThresholdBelow: 100,
    rebalanceThresholdsKnown: true,
    lastRebalancedAt: String(now - DAY_SECONDS),
    deviationBreachStartedAt: null,
    lpFee: 20,
    protocolFee: 5,
    rebalanceReward: 0,
    limitStatus: "OK",
    limitPressure0: "0",
    limitPressure1: "0",
    rebalancerAddress: "",
    reserves0,
    reserves1,
    swapCount: 3,
    rebalanceCount: 0,
    notionalVolume0,
    notionalVolume1,
    healthTotalSeconds: "604800",
    healthBinarySeconds: "0",
    hasHealthData: true,
    breachCount: 0,
  };
}

const pools = [
  poolFixture({
    id: ADDRESSES.celoPool,
    chainId: 42220,
    token0: ADDRESSES.celoUsdm,
    token1: ADDRESSES.celoUsdc,
    token0Decimals: 18,
    token1Decimals: 6,
    reserves0: "2000000000000000000000",
    reserves1: "2000000000",
    notionalVolume0: "125000000000000000000",
    notionalVolume1: "125000000",
  }),
  poolFixture({
    id: ADDRESSES.monadPool,
    chainId: 143,
    token0: ADDRESSES.monadAusd,
    token1: ADDRESSES.monadUsdm,
    token0Decimals: 18,
    token1Decimals: 18,
    reserves0: "3000000000000000000000",
    reserves1: "3000000000000000000000",
    notionalVolume0: "750000000000000000000",
    notionalVolume1: "750000000000000000000",
  }),
];

const poolsById = new Map(pools.map((pool) => [pool.id, pool]));

function tradingLimitFixture(pool, token, limit0, limit1) {
  return {
    id: `${pool.id}-${token}`,
    chainId: pool.chainId,
    poolId: pool.id,
    token,
    limit0,
    limit1,
    decimals: 15,
    netflow0: "0",
    netflow1: "0",
    lastUpdated0: "0",
    lastUpdated1: "0",
    limitPressure0: "0",
    limitPressure1: "0",
    limitStatus: "OK",
    updatedAtBlock: pool.updatedAtBlock,
    updatedAtTimestamp: pool.updatedAtTimestamp,
  };
}

const tradingLimits = pools.flatMap((pool) => [
  tradingLimitFixture(
    pool,
    pool.token0,
    "77000000000000000000",
    "154000000000000000000",
  ),
  tradingLimitFixture(
    pool,
    pool.token1,
    "100000000000000000000",
    "200000000000000000000",
  ),
]);

function poolRowsForChain(chainId) {
  return pools.filter((pool) => pool.chainId === Number(chainId));
}

function oracleRateRowsForChain(chainId) {
  const rows = poolRowsForChain(chainId);
  if (Number(chainId) !== 42220) return rows;
  return [
    ...rows,
    {
      token0: ADDRESSES.celoUsdm,
      token1: ADDRESSES.celoGbpm,
      oraclePrice: "1250000000000000000000000",
      oracleOk: true,
    },
    {
      token0: ADDRESSES.celoUsdm,
      token1: ADDRESSES.celoChfm,
      oraclePrice: "1100000000000000000000000",
      oracleOk: true,
    },
    {
      token0: ADDRESSES.celoUsdm,
      token1: ADDRESSES.celoJpym,
      oraclePrice: "6250000000000000000000",
      oracleOk: true,
    },
  ];
}

function poolLabelRowsForChain(chainId) {
  return poolRowsForChain(chainId).map(({ id, token0, token1, source }) => ({
    id,
    token0,
    token1,
    source,
  }));
}

function poolDailyFeeSnapshotsForChain(chainId) {
  if (Number(chainId) !== 42220) return [];
  const timestamp = String(volumeDay());
  const poolAddress = ADDRESSES.celoPool.split("-")[1];
  return [
    {
      id: `42220-${poolAddress}-${timestamp}`,
      chainId: 42220,
      poolAddress,
      timestamp,
      tokens: [ADDRESSES.celoUsdm],
      tokenSymbols: ["USDm"],
      tokenDecimals: [18],
      amounts: ["1000000000000000000"],
      feesUsdWei: "1000000000000000000",
    },
  ];
}

const borrowingRevenueCollaterals = [
  {
    id: "42220-gbpm",
    chainId: 42220,
    collIndex: 0,
    symbol: "GBPm",
    spYieldSplitBps: 7500,
  },
  {
    id: "42220-chfm",
    chainId: 42220,
    collIndex: 1,
    symbol: "CHFm",
    spYieldSplitBps: 7500,
  },
  {
    id: "42220-jpym",
    chainId: 42220,
    collIndex: 2,
    symbol: "JPYm",
    spYieldSplitBps: 7500,
  },
];

const borrowingRevenueInstances = borrowingRevenueCollaterals.map(
  (collateral, i) => ({
    id: `${collateral.id}-instance`,
    collateralId: collateral.id,
    chainId: collateral.chainId,
    systemDebt: String(BigInt(1000 + i * 100) * 10n ** 18n),
    activeTroveCount: 3 + i,
    borrowingFeeCum: String(BigInt(10 + i * 5) * 10n ** 18n),
    borrowingFeeCollectedCum: String(BigInt(1 + i) * 10n ** 18n),
  }),
);

function cdpBorrowingRevenueBrackets(collateralIds) {
  const ids = new Set(collateralIds ?? []);
  const timestamp = String(nowSeconds() - DAY_SECONDS);
  return borrowingRevenueCollaterals
    .filter((collateral) => ids.has(collateral.id))
    .map((collateral, i) => {
      const rate = BigInt(5 + i) * 10n ** 16n;
      const totalDebt = BigInt(1000 + i * 100) * 10n ** 18n;
      return {
        id: `${collateral.id}-${rate}`,
        collateralId: collateral.id,
        rate: String(rate),
        totalDebt: String(totalDebt),
        sumDebtTimesRateD36: String(totalDebt * rate),
        pendingDebtTimesOneYearD36: "0",
        updatedAt: timestamp,
      };
    });
}

function cdpBorrowingRevenueDailySnapshots(chainId) {
  if (Number(chainId) !== 42220) return [];
  const timestamp = String(volumeDay());
  return borrowingRevenueInstances.map((instance, i) => ({
    id: `${instance.id}-${timestamp}`,
    chainId: instance.chainId,
    collateralId: instance.collateralId,
    instanceId: instance.id,
    timestamp,
    upfrontFee: String(BigInt(1 + i) * 10n ** 18n),
    accruedInterest: String(BigInt(2 + i) * 10n ** 17n),
    collected: String(BigInt(1 + i) * 10n ** 17n),
  }));
}

function thresholdRows(rows) {
  return rows.map((pool) => ({
    id: pool.id,
    rebalanceThresholdAbove: pool.rebalanceThresholdAbove,
    rebalanceThresholdBelow: pool.rebalanceThresholdBelow,
    rebalanceThresholdsKnown: pool.rebalanceThresholdsKnown,
    tokenDecimalsKnown: pool.tokenDecimalsKnown,
  }));
}

function breachRollupRows(rows) {
  return rows.map((pool) => ({
    id: pool.id,
    breachCount: pool.breachCount,
    healthBinarySeconds: pool.healthBinarySeconds,
    healthTotalSeconds: pool.healthTotalSeconds,
  }));
}

function dailySnapshotsFor(poolId) {
  const pool = poolsById.get(poolId);
  if (!pool) return [];
  const todayStart = Math.floor(nowSeconds() / DAY_SECONDS) * DAY_SECONDS;
  return [0, 1, 2].map((daysAgo) => ({
    id: `${poolId}-${todayStart - daysAgo * DAY_SECONDS}`,
    poolId,
    timestamp: String(todayStart - daysAgo * DAY_SECONDS),
    reserves0: pool.reserves0,
    reserves1: pool.reserves1,
    swapCount: daysAgo === 0 ? 1 : 2,
    swapVolume0:
      daysAgo === 0 ? "25000000000000000000" : "50000000000000000000",
    swapVolume1:
      pool.token1Decimals === 6
        ? daysAgo === 0
          ? "25000000"
          : "50000000"
        : daysAgo === 0
          ? "25000000000000000000"
          : "50000000000000000000",
    rebalanceCount: 0,
    cumulativeSwapCount: 3 - daysAgo,
    cumulativeVolume0: "125000000000000000000",
    cumulativeVolume1:
      pool.token1Decimals === 6 ? "125000000" : "125000000000000000000",
    blockNumber: String(2000 - daysAgo),
  }));
}

function oracleSnapshotsFor(poolId) {
  const pool = poolsById.get(poolId);
  if (!pool) return [];
  return [
    {
      id: `${poolId}-oracle-1`,
      chainId: pool.chainId,
      poolId,
      timestamp: String(nowSeconds() - 60),
      oraclePrice: FIXED_1,
      oracleOk: true,
      numReporters: 5,
      source: "oracle_median_updated",
      blockNumber: "2200",
      txHash:
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      breakerBaselineAtSnapshot: null,
      breakerThresholdAtSnapshot: null,
    },
  ];
}

const swaps = [
  {
    id: "swap-1",
    chainId: 42220,
    poolId: ADDRESSES.celoPool,
    sender: ADDRESSES.trader,
    recipient: ADDRESSES.recipient,
    amount0In: "10000000000000000000",
    amount1In: "0",
    amount0Out: "0",
    amount1Out: "10000000",
    txHash:
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    blockNumber: "2100",
    blockTimestamp: String(nowSeconds() - 120),
  },
];

const liquidityPositions = [
  {
    id: "lp-1",
    poolId: ADDRESSES.celoPool,
    address: ADDRESSES.lp,
    netLiquidity: "1000000000000000000",
    lastUpdatedBlock: "2090",
    lastUpdatedTimestamp: String(nowSeconds() - 300),
  },
];

const stableFixtureNow = Math.floor(Date.parse("2026-04-15T12:00:00Z") / 1000);
const stableFixtureToday =
  Math.floor(stableFixtureNow / DAY_SECONDS) * DAY_SECONDS;

function stableSnapshot(id, tokenAddress, tokenSymbol, timestamp, totalSupply) {
  return {
    id,
    chainId: 42220,
    tokenAddress,
    tokenSymbol,
    source: "RESERVE",
    tokenDecimals: 18,
    timestamp: String(timestamp),
    totalSupply,
    dailyMintAmount: "0",
    dailyBurnAmount: "0",
  };
}

const stableDailySnapshots = [
  stableSnapshot(
    "usdm-old",
    ADDRESSES.celoUsdm,
    "USDm",
    stableFixtureToday - DAY_SECONDS,
    "1000000000000000000000",
  ),
  stableSnapshot(
    "usdm-new",
    ADDRESSES.celoUsdm,
    "USDm",
    stableFixtureToday,
    "1100000000000000000000",
  ),
  stableSnapshot(
    "gbpm-old",
    ADDRESSES.celoGbpm,
    "GBPm",
    stableFixtureToday - DAY_SECONDS,
    "400000000000000000000",
  ),
  stableSnapshot(
    "gbpm-new",
    ADDRESSES.celoGbpm,
    "GBPm",
    stableFixtureToday,
    "500000000000000000000",
  ),
];

function stableChange(id, tokenAddress, tokenSymbol, amount, secondsAgo) {
  return {
    id,
    chainId: 42220,
    tokenAddress,
    tokenSymbol,
    tokenDecimals: 18,
    source: "RESERVE",
    kind: amount.startsWith("-") ? "RESERVE_BURN" : "RESERVE_MINT",
    counterparty: ADDRESSES.recipient,
    caller: ADDRESSES.trader,
    txTo: ADDRESSES.recipient,
    isProtocolOwnedCaller: false,
    amount,
    txHash: `0x${id.padEnd(64, "0").slice(0, 64)}`,
    blockNumber: "123",
    blockTimestamp: String(stableFixtureNow - secondsAgo),
  };
}

const stableChanges = [
  stableChange("dust", ADDRESSES.celoUsdm, "USDm", "9000000000000000", 60),
  stableChange(
    "usdm-visible",
    ADDRESSES.celoUsdm,
    "USDm",
    "20000000000000000",
    120,
  ),
  stableChange(
    "gbpm-half",
    ADDRESSES.celoGbpm,
    "GBPm",
    "500000000000000000",
    180,
  ),
  stableChange(
    "gbpm-one",
    ADDRESSES.celoGbpm,
    "GBPm",
    "1000000000000000000",
    240,
  ),
  stableChange(
    "unpriced-brlm",
    ADDRESSES.celoBrlm,
    "BRLm",
    "1000000000000000000",
    300,
  ),
];

const cdpCollateralId = `42220-${ADDRESSES.celoTroveManagerGbpm}`;
const cdpInstanceId = cdpCollateralId;
const cdpNow = stableFixtureNow;

const cdpCollaterals = [
  {
    id: cdpCollateralId,
    chainId: 42220,
    collIndex: 0,
    symbol: "GBPm",
    debtToken: ADDRESSES.celoGbpm,
    collToken: ADDRESSES.celoUsdm,
    troveManager: ADDRESSES.celoTroveManagerGbpm,
    stabilityPool: ADDRESSES.celoStabilityPoolGbpm,
    minDebt: "1000000000000000000000",
    minBoldInSp: "100000000000000000000",
    systemParamsLoaded: true,
    mcrBps: 11000,
    ccrBps: 13500,
    scrBps: 15000,
  },
];

const cdpInstances = [
  {
    id: cdpInstanceId,
    collateralId: cdpCollateralId,
    chainId: 42220,
    systemColl: "8000000000000000000000",
    systemDebt: "3000000000000000000000",
    tcrBps: 26666,
    spDeposits: "1200000000000000000000",
    spColl: "100000000000000000000",
    spHeadroom: "1200000000000000000000",
    currentRedemptionRateBps: 50,
    activeTroveCount: 2,
    icrP1Bps: 15100,
    icrP5Bps: 17500,
    icrP50Bps: 24000,
    icrFracBelowMcrBps: 0,
    liqCountCum: 0,
    redemptionCountCum: 3,
    redemptionDebtCum: "90000000000000000000",
    redemptionFeeCum: "1000000000000000000",
    rebalanceRedemptionCountCum: 2,
    rebalanceRedemptionDebtCum: "60000000000000000000",
    rebalanceRedemptionFeeCum: "700000000000000000",
    borrowingFeeCum: "2500000000000000000",
    isShutDown: false,
    shutDownAt: null,
    shutDownTcrBps: null,
    lastEventBlock: "12345678",
    lastEventTimestamp: String(cdpNow - 300),
  },
];

const cdpTroves = [
  {
    id: `${cdpCollateralId}-1`,
    collateralId: cdpCollateralId,
    chainId: 42220,
    troveId: "1",
    owner: ADDRESSES.troveOwnerA,
    status: "active",
    debt: "1000000000000000000000",
    coll: "2100000000000000000000",
    icrBps: 21000,
    interestRate: "21000000000000000",
    interestBatchId: null,
    lastUpdatedAt: String(cdpNow - 600),
    lastUpdatedTxHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    redemptionCount: 1,
    redeemedDebt: "10000000000000000000",
    redeemedColl: "20000000000000000000",
  },
  {
    id: `${cdpCollateralId}-2`,
    collateralId: cdpCollateralId,
    chainId: 42220,
    troveId: "2",
    owner: ADDRESSES.troveOwnerB,
    status: "zombie",
    debt: "2000000000000000000000",
    coll: "5900000000000000000000",
    icrBps: 29500,
    interestRate: "0",
    interestBatchId: `${cdpCollateralId}-batch-low`,
    lastUpdatedAt: String(cdpNow - 900),
    lastUpdatedTxHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    redemptionCount: 0,
    redeemedDebt: "0",
    redeemedColl: "0",
  },
  {
    id: `${cdpCollateralId}-3`,
    collateralId: cdpCollateralId,
    chainId: 42220,
    troveId: "3",
    owner: "0x6666666666666666666666666666666666666666",
    status: "redeemed",
    debt: "0",
    coll: "0",
    icrBps: -1,
    interestRate: "26000000000000000",
    interestBatchId: null,
    lastUpdatedAt: String(cdpNow - 3600),
    lastUpdatedTxHash:
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    redemptionCount: 1,
    redeemedDebt: "50000000000000000000",
    redeemedColl: "110000000000000000000",
  },
];

const cdpInterestBatches = [
  {
    id: `${cdpCollateralId}-batch-low`,
    collateralId: cdpCollateralId,
    batchManager: "0x7777777777777777777777777777777777777777",
    annualInterestRate: "19000000000000000",
    updatedAt: String(cdpNow - 1000),
  },
];

const cdpDailySnapshots = [
  {
    id: `${cdpInstanceId}-${stableFixtureToday - DAY_SECONDS}`,
    instanceId: cdpInstanceId,
    timestamp: String(stableFixtureToday - DAY_SECONDS),
    spDeposits: "1100000000000000000000",
    spColl: "90000000000000000000",
    spHeadroom: "1100000000000000000000",
    systemDebt: "2900000000000000000000",
    systemColl: "7600000000000000000000",
  },
  {
    id: `${cdpInstanceId}-${stableFixtureToday}`,
    instanceId: cdpInstanceId,
    timestamp: String(stableFixtureToday),
    spDeposits: "1200000000000000000000",
    spColl: "100000000000000000000",
    spHeadroom: "1200000000000000000000",
    systemDebt: "3000000000000000000000",
    systemColl: "8000000000000000000000",
  },
];

const cdpTransactions = {
  LiquidationEvent: [],
  RedemptionEvent: [
    {
      id: `${cdpInstanceId}-redemption-1`,
      instanceId: cdpInstanceId,
      attemptedBoldAmount: "50000000000000000000",
      actualBoldAmount: "45000000000000000000",
      ETHSent: "100000000000000000000",
      ETHFee: "500000000000000000",
      price: "750000000000000000",
      redemptionPrice: "750000000000000000",
      isRebalance: true,
      timestamp: String(cdpNow - 700),
      blockNumber: "12345000",
      txHash:
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
  ],
  SpRebalanceEvent: [],
  TroveOperationEvent: [
    {
      id: `${cdpInstanceId}-op-1`,
      instanceId: cdpInstanceId,
      troveId: "1",
      operation: 2,
      collChange: "100000000000000000000",
      debtChange: "50000000000000000000",
      annualInterestRate: "21000000000000000",
      debtIncreaseFromUpfrontFee: "1000000000000000000",
      timestamp: String(cdpNow - 600),
      blockNumber: "12345100",
      txHash:
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    },
  ],
};

const cdpTroveOpSnapshots = [
  {
    id: `${cdpInstanceId}-op-1`,
    owner: ADDRESSES.troveOwnerA,
    debtBefore: "950000000000000000000",
    debtAfter: "1000000000000000000000",
    collBefore: "2000000000000000000000",
    collAfter: "2100000000000000000000",
  },
];

function cdpRowsForChain(rows, chainId) {
  return rows.filter((row) => row.chainId === Number(chainId));
}

function cdpRowsForCollateral(rows, collateralId) {
  return rows.filter((row) => row.collateralId === String(collateralId));
}

function cdpMarketDetailRows(collateralId) {
  return {
    LiquityCollateral: cdpRowsForCollateral(cdpCollaterals, collateralId),
    LiquityInstance: cdpRowsForCollateral(cdpInstances, collateralId),
    OpenTrove: cdpRowsForCollateral(cdpTroves, collateralId).filter((trove) =>
      ["active", "zombie"].includes(trove.status),
    ),
    AllTrove: cdpRowsForCollateral(cdpTroves, collateralId),
    InterestBatch: cdpRowsForCollateral(cdpInterestBatches, collateralId),
    StabilityPoolDepositor: [],
    CdpPool: [
      {
        id: `${collateralId}-${ADDRESSES.celoPool}`,
        poolId: ADDRESSES.celoPool,
        debtToken: ADDRESSES.celoGbpm,
        strategyAddress: "0x8888888888888888888888888888888888888888",
        rebalanceCooldownSec: 3600,
        addedAtTimestamp: String(cdpNow - DAY_SECONDS),
        updatedAtTimestamp: String(cdpNow - 120),
      },
    ],
  };
}

function volumeDay() {
  return Math.floor(nowSeconds() / DAY_SECONDS) * DAY_SECONDS;
}

function brokerAggregatorDailySnapshots() {
  const timestamp = String(volumeDay());
  return [
    {
      id: `42220-squid-${timestamp}`,
      chainId: 42220,
      aggregator: "squid",
      lastSeenAggregatorAddress: "0xce16f69375520ab01377ce7b88f5ba8c48f8d666",
      timestamp,
      swapCount: 0,
      swapCountIncludingProtocolActors: 1,
      uniqueTraders: 0,
      uniqueTradersIncludingProtocolActors: 1,
      volumeUsdWei: "0",
      volumeUsdWeiIncludingProtocolActors: "1000000000000000000000",
    },
  ];
}

function unhandledOperation(op) {
  const message = `Unhandled fixture GraphQL operation: ${op}`;
  process.stderr.write(`${message}\n`);
  return { __fixtureErrors: [{ message }] };
}

function operationName(query) {
  return query.match(/\bquery\s+([A-Za-z0-9_]+)/)?.[1] ?? "Unknown";
}

function rowsByPoolIds(poolIds) {
  const ids = new Set(poolIds ?? []);
  return pools.flatMap((pool) =>
    ids.size === 0 || ids.has(pool.id) ? dailySnapshotsFor(pool.id) : [],
  );
}

function handleGraphQL({ query, variables = {} }) {
  const op = operationName(query ?? "");
  switch (op) {
    case "PoolsForVolume":
      return {
        Pool: pools.map(({ id, chainId, token0, token1 }) => ({
          id,
          chainId,
          token0,
          token1,
        })),
      };
    case "TraderDailyTop":
      return { TraderDailySnapshot: [] };
    case "PoolDailyVolume":
      return { PoolDailyVolumeSnapshot: [] };
    case "AggregatorDailyTop":
    case "AggregatorDailyTopIncludingProtocolActors":
      return { AggregatorDailySnapshot: [] };
    case "BrokerTraderDailyTop":
      return { BrokerTraderDailySnapshot: [] };
    case "BrokerAggregatorDailyTop":
    case "BrokerAggregatorDailyTopIncludingProtocolActors":
      return {
        BrokerAggregatorDailySnapshot: brokerAggregatorDailySnapshots(),
      };
    case "VolumeWindowLatest":
      return { volumeWindowSnapshots: [] };
    case "BrokerVolumeWindowLatest":
      return { brokerVolumeWindowSnapshots: [] };
    case "VolumeWindowFirstDayLatest":
      return { volumeWindowFirstDaySnapshots: [] };
    case "BrokerVolumeWindowFirstDayLatest":
      return { brokerVolumeWindowFirstDaySnapshots: [] };
    case "VolumeWindowTradersLatest":
      return { volumeWindowTraderSnapshots: [] };
    case "VolumePartialOverlapTraders":
      return { volumePartialOverlapTraders: [] };
    case "BrokerVolumePartialOverlapTraders":
      return { brokerVolumePartialOverlapTraders: [] };
    case "VolumeTodayTraders":
      return { volumeTodayTraders: [] };
    case "BrokerVolumeTodayTraders":
      return { brokerVolumeTodayTraders: [] };
    case "VolumeYesterdayTraders":
      return { volumeYesterdayTraders: [] };
    case "BrokerVolumeYesterdayTraders":
      return { brokerVolumeYesterdayTraders: [] };
    case "AllPoolsWithHealth":
      return { Pool: poolRowsForChain(variables.chainId) };
    case "OracleRates":
      return { Pool: oracleRateRowsForChain(variables.chainId) };
    case "PoolLabelsAll":
      return { Pool: poolLabelRowsForChain(variables.chainId) };
    case "AllPoolsRebalanceThresholdsKnown":
      return { Pool: thresholdRows(poolRowsForChain(variables.chainId)) };
    case "AllPoolsBreachRollup":
      return { Pool: breachRollupRows(poolRowsForChain(variables.chainId)) };
    case "AllPoolsHealthCursor":
      return {
        Pool: poolRowsForChain(variables.chainId).map((pool) => ({
          id: pool.id,
          lastOracleSnapshotTimestamp: null,
          lastDeviationRatio: null,
        })),
      };
    case "AllCdpPools":
      return {
        CdpPool:
          Number(variables.chainId) === 42220
            ? [
                {
                  poolId: ADDRESSES.celoPool,
                  collateralId: ADDRESSES.celoGbpm,
                  strategyAddress: "0x8888888888888888888888888888888888888888",
                },
              ]
            : [],
      };
    case "PoolDetailWithHealth": {
      const pool = poolsById.get(String(variables.id));
      return {
        Pool: pool && pool.chainId === Number(variables.chainId) ? [pool] : [],
      };
    }
    case "PoolThresholdsKnownExt": {
      const pool = poolsById.get(String(variables.id));
      return { Pool: pool ? thresholdRows([pool]) : [] };
    }
    case "PoolBreachRollup": {
      const pool = poolsById.get(String(variables.id));
      return { Pool: pool ? breachRollupRows([pool]) : [] };
    }
    case "PoolHealth7dAnchor":
      return {
        PoolDailySnapshot: [
          {
            timestamp: String(nowSeconds() - 7 * DAY_SECONDS),
            cumulativeHealthBinarySeconds: "0",
            cumulativeHealthTotalSeconds: "0",
          },
        ],
      };
    case "PoolDailySnapshotsAll":
    case "HomepageOgDailySnapshots":
      return { PoolDailySnapshot: rowsByPoolIds(variables.poolIds) };
    case "PoolDailySnapshotsChart":
    case "PoolOgDailySnapshots":
      return {
        PoolDailySnapshot: dailySnapshotsFor(String(variables.poolId)),
      };
    case "OracleSnapshots":
    case "OracleSnapshotsChart":
      return {
        OracleSnapshot: oracleSnapshotsFor(String(variables.poolId)).slice(
          0,
          variables.limit ?? undefined,
        ),
      };
    case "OracleSnapshotsChartBandsExt":
      return {
        OracleSnapshot: oracleSnapshotsFor(String(variables.poolId)).map(
          (snapshot) => ({
            id: snapshot.id,
            breakerBaselineAtSnapshot: snapshot.breakerBaselineAtSnapshot,
            breakerThresholdAtSnapshot: snapshot.breakerThresholdAtSnapshot,
          }),
        ),
      };
    case "OracleSnapshotsCountPage":
      return {
        OracleSnapshot: oracleSnapshotsFor(String(variables.poolId)).map(
          (snapshot) => ({ id: snapshot.id }),
        ),
      };
    case "PoolDailyFeeSnapshotsPage":
      return {
        PoolDailyFeeSnapshot: poolDailyFeeSnapshotsForChain(
          variables.chainId,
        ).slice(
          variables.offset ?? 0,
          (variables.offset ?? 0) + variables.limit,
        ),
      };
    case "CdpBorrowingRevenueMarkets":
      return {
        LiquityCollateral:
          Number(variables.chainId) === 42220
            ? borrowingRevenueCollaterals
            : [],
        LiquityInstance:
          Number(variables.chainId) === 42220 ? borrowingRevenueInstances : [],
      };
    case "CdpBorrowingRevenueBrackets":
      return {
        InterestRateBracket: cdpBorrowingRevenueBrackets(
          variables.collateralIds,
        ).slice(
          variables.offset ?? 0,
          (variables.offset ?? 0) + variables.limit,
        ),
      };
    case "CdpBorrowingRevenueDailySnapshots":
      return {
        LiquityBorrowingRevenueDailySnapshot: cdpBorrowingRevenueDailySnapshots(
          variables.chainId,
        ).slice(
          variables.offset ?? 0,
          (variables.offset ?? 0) + variables.limit,
        ),
      };
    case "BrokerDailySnapshotsAll":
      return { BrokerDailySnapshot: [] };
    case "AllTradingLimits":
      return {
        TradingLimit: tradingLimits.filter(
          (limit) => limit.chainId === Number(variables.chainId),
        ),
      };
    case "TradingLimits":
      return {
        TradingLimit: tradingLimits.filter(
          (limit) => limit.poolId === String(variables.poolId),
        ),
      };
    case "AllOlsPools":
    case "OlsPool":
      return { OlsPool: [] };
    case "UniqueLpAddresses":
      return { LiquidityPosition: [] };
    case "PoolLpPositions":
      return {
        LiquidityPosition:
          variables.poolId === ADDRESSES.celoPool ? liquidityPositions : [],
      };
    case "RecentSwaps":
      return { SwapEvent: swaps.slice(0, variables.limit ?? swaps.length) };
    case "PoolSwaps":
    case "PoolSwapsPage":
      return {
        SwapEvent: swaps
          .filter((swap) => swap.poolId === variables.poolId)
          .slice(0, variables.limit ?? swaps.length),
      };
    case "PoolSwapsCount":
      return {
        SwapEvent: swaps
          .filter((swap) => swap.poolId === variables.poolId)
          .map((swap) => ({ id: swap.id })),
      };
    case "PoolDeployment":
      return {
        FactoryDeployment: [
          {
            txHash:
              "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
        ],
      };
    case "PoolConfigExt": {
      const pool = poolsById.get(String(variables.id));
      return { Pool: pool ? [{ id: pool.id, rebalanceReward: 0 }] : [] };
    }
    case "PoolRebalances":
      return { RebalanceEvent: [] };
    case "StablesCurrentSupplyPerToken":
      return {
        StableTokenSupply: [stableDailySnapshots[1], stableDailySnapshots[3]],
      };
    case "StablesLatestPerToken":
      return {
        StableSupplyDailySnapshot: [
          stableDailySnapshots[1],
          stableDailySnapshots[3],
        ],
      };
    case "StablesDailySnapshots":
      return { StableSupplyDailySnapshot: stableDailySnapshots };
    case "StablesCurrentCustodyPerToken":
      return { StableTokenCustodyState: [] };
    case "StablesLatestCustodyPerToken":
    case "StablesCustodyDailySnapshots":
      return { StableTokenCustodyDailySnapshot: [] };
    case "StablesChanges":
      return {
        StableSupplyChangeEvent: stableChanges.slice(
          variables.offset ?? 0,
          (variables.offset ?? 0) + (variables.limit ?? stableChanges.length),
        ),
      };
    case "CdpMarkets": {
      const collaterals = cdpRowsForChain(cdpCollaterals, variables.chainId);
      const collateralIds = new Set(collaterals.map((row) => row.id));
      return {
        LiquityCollateral: collaterals,
        LiquityInstance: cdpRowsForChain(cdpInstances, variables.chainId),
        Trove: cdpTroves
          .filter(
            (trove) =>
              collateralIds.has(trove.collateralId) &&
              ["active", "zombie"].includes(trove.status),
          )
          .map(({ id, collateralId, status }) => ({
            id,
            collateralId,
            status,
          })),
      };
    }
    case "CdpTroveSchemaFields":
      return {
        __type: {
          fields: [
            { name: "id" },
            { name: "lastUpdatedAt" },
            { name: "lastUpdatedTxHash" },
          ],
        },
      };
    case "CdpMarketDetail": {
      const collateralId = String(variables.collateralId);
      return cdpMarketDetailRows(collateralId);
    }
    case "CdpMarketDetailWithTroveTx": {
      const collateralId = String(variables.collateralId);
      return cdpMarketDetailRows(collateralId);
    }
    case "CdpInstanceDailySnapshots":
      return {
        LiquityInstanceDailySnapshot:
          String(variables.instanceId) === cdpInstanceId
            ? cdpDailySnapshots
            : [],
      };
    case "CdpTransactions":
      return cdpTransactions;
    case "CdpTroveOpSnapshots":
      return { TroveOperationEvent: cdpTroveOpSnapshots };
    default:
      return unhandledOperation(op);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.url !== "/graphql" || req.method !== "POST") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    try {
      const body = JSON.parse(raw);
      const result = handleGraphQL(body);
      if (result.__fixtureErrors) {
        sendJson(res, 200, { errors: result.__fixtureErrors });
        return;
      }
      sendJson(res, 200, { data: result });
    } catch (error) {
      sendJson(res, 500, {
        errors: [
          {
            message:
              error instanceof Error ? error.message : "fixture server error",
          },
        ],
      });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Hasura fixture server listening on ${port}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
