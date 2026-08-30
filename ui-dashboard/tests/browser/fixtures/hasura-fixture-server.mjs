#!/usr/bin/env node
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FIXTURE_LIGHTHOUSE_SCENARIO } from "../../../scripts/fixture-constants.mjs";
import {
  currentFixtureServerIdentity,
  fixtureServerRuntimeOptions,
} from "../../../scripts/fixture-identity.mjs";

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const DAY_SECONDS = 86_400;
const FIXED_1 = "1000000000000000000000000";
const LIGHTHOUSE_POOL_SCENARIO = FIXTURE_LIGHTHOUSE_SCENARIO;
const LIGHTHOUSE_POOL_REFERENCE_RATE_FEED_ID =
  "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";

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
  stabilityPoolLp: "0x9999999999999999999999999999999999999999",
  // The ticket-#0754 case-study owner (docs/PLAN-trove-history-page.md).
  troveHistoryOwner: "0xcca0a99b94529493ddffe7c61a3ae454828cd3bb",
  celoTroveManagerChfm: "0xabababababababababababababababababababab",
  celoStabilityPoolChfm: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
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
    lastOracleReportAt: String(now - 60),
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

const lighthousePoolBreakerResponse = {
  BreakerConfig: [
    {
      id: "42220-lighthouse-pool-median-delta",
      enabled: true,
      cooldownTime: "0",
      rateChangeThreshold: "0",
      smoothingFactor: "5000000000000000000000",
      medianRatesEMA: "1171560280196965000000000",
      referenceValue: null,
      lastMedianRate: "1175000000000000000000000",
      lastUpdatedAt: "1776254400",
      status: "OK",
      tradingMode: 0,
      lastStatusUpdatedAt: "1776254400",
      cooldownEndsAt: "0",
      lastTripAt: null,
      lastTripTxHash: null,
      lastResetAt: null,
      tripCountLifetime: 0,
      breaker: {
        id: "42220-lighthouse-pool-breaker",
        address: "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9",
        kind: "MEDIAN_DELTA",
        activatesTradingMode: 3,
        defaultCooldownTime: "900",
        defaultRateChangeThreshold: "40000000000000000000000",
      },
    },
  ],
  BreakerTripEvent: [],
};

const lighthousePoolRateFeedResponse = {
  RateFeed: [
    {
      id: `42220-${LIGHTHOUSE_POOL_REFERENCE_RATE_FEED_ID}`,
      chainId: 42220,
      feedAddress: LIGHTHOUSE_POOL_REFERENCE_RATE_FEED_ID,
      pair: "EUR/USD",
      reporterTypes: ["CHAINLINK"],
    },
  ],
};

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

function vpOracleFreshnessRows(rows) {
  return rows.map((pool) => ({
    id: pool.id,
    updatedAtBlock: pool.updatedAtBlock,
    oracleTimestamp: pool.oracleTimestamp,
    oracleNumReporters: pool.oracleNumReporters,
    tokenDecimalsKnown: pool.tokenDecimalsKnown,
    lastOracleReportAt: pool.oracleTimestamp,
    medianLive: true,
    oracleFreshnessWindow: pool.oracleExpiry,
  }));
}

function dailySnapshotsFor(poolId, daysAgoValues = [0, 1, 2]) {
  const pool = poolsById.get(poolId);
  if (!pool) return [];
  const todayStart = Math.floor(nowSeconds() / DAY_SECONDS) * DAY_SECONDS;
  return daysAgoValues.map((daysAgo) => ({
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
    cumulativeSwapCount: daysAgo >= 365 ? 1 : 3 - daysAgo,
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

// ---------------------------------------------------------------------------
// Trove history route fixtures (docs/PLAN-trove-history-page.md, the ticket
// #0754 case study): a SECOND CDP market so the case-study trove and its
// complete ledger never disturb the GBPm market the pre-existing browser
// assertions pin (row order there is redemption-priority order, and a new
// 1.6% trove would take the first row). The case trove models the verified
// timeline — open at 0.5%, five rebalance redemptions, a rate change to
// 1.6%, then a +30,000 USDm / +2,500 debt adjust — with every snapshot
// chained exactly (debtBefore + deltas = debtAfter) and the Trove
// cumulatives equal to the ledger-row sums, so the impact panel's
// reconciliation passes against the watermark of the newest row.

const D18_WEI = 10n ** 18n;

/** Whole-or-2dp token amounts to wei strings — same arithmetic as the
 *  impact unit tests' `wei` helper, so chained snapshots stay exact. */
function tokenWei(amount) {
  return ((BigInt(Math.round(amount * 100)) * D18_WEI) / 100n).toString();
}

/** Annual interest rate percent (2dp) on the D18 scale (1e18 = 100%). */
function ratePctWei(percent) {
  return (BigInt(Math.round(percent * 100)) * 10n ** 14n).toString();
}

const cdpChfmCollateralId = `42220-${ADDRESSES.celoTroveManagerChfm}`;
// Normalized on-chain hex id (no leading zeros) — the route param form.
const CDP_CASE_TROVE_ID = "0x754";
const cdpCaseTroveEntityId = `${cdpChfmCollateralId}-${CDP_CASE_TROVE_ID}`;

const caseOpenedAt = cdpNow - 70 * DAY_SECONDS;
const caseRedemptionsStartAt = cdpNow - 2 * DAY_SECONDS;
const caseRateChangeAt = cdpNow - DAY_SECONDS;
const caseAdjustAt = caseRateChangeAt + 300;

// D18 debt-per-collateral oracle rate: 0.75 debt per USDm, so 3,690.00 of
// debt is worth exactly 4,920.00 USDm at each hit — division is exact.
const CASE_ORACLE_PRICE = ((3n * D18_WEI) / 4n).toString();

function caseTxHash(index) {
  return `0x${String(index).padStart(2, "0").repeat(32)}`;
}

function caseLedgerRow({
  operation,
  timestamp,
  blockNumber,
  logIndex,
  txHash,
  collChange,
  debtChange,
  upfrontFee = "0",
  debtBefore,
  debtAfter,
  collBefore,
  collAfter,
  annualInterestRate,
  statusBefore = "active",
  statusAfter = "active",
  redemptionFeeCredited = null,
  isRebalance = null,
  redemptionPrice = null,
  icrAfterBps,
}) {
  return {
    id: `42220_${blockNumber}_${logIndex}`,
    operation,
    collChange,
    debtChange,
    debtIncreaseFromUpfrontFee: upfrontFee,
    debtIncreaseFromRedist: "0",
    collIncreaseFromRedist: "0",
    annualInterestRate,
    debtBefore,
    debtAfter,
    collBefore,
    collAfter,
    statusBefore,
    statusAfter,
    redemptionFeeCredited,
    isRebalance,
    redemptionPrice,
    priceAtEvent: CASE_ORACLE_PRICE,
    icrAfterBps,
    timestamp: String(timestamp),
    blockNumber: String(blockNumber),
    logIndex,
    txHash,
  };
}

/** One op-6 rebalance hit: repays 3,690.00 debt, takes 4,916.50 USDm net of
 *  the 2.50 USDm fee credited to the trove. At the 0.75 oracle rate the
 *  debt is worth 4,920.00 USDm, so each hit's net equity is +3.50 USDm. */
function caseRedemptionRow(
  index,
  { debtBefore, debtAfter, collBefore, collAfter, icrAfterBps },
) {
  return caseLedgerRow({
    operation: 6,
    timestamp: caseRedemptionsStartAt + index * 600,
    blockNumber: 20_950_000 + index * 30,
    logIndex: 3,
    txHash: caseTxHash(2 + index),
    collChange: `-${tokenWei(4916.5)}`,
    debtChange: `-${tokenWei(3690)}`,
    debtBefore,
    debtAfter,
    collBefore,
    collAfter,
    annualInterestRate: ratePctWei(0.5),
    redemptionFeeCredited: tokenWei(2.5),
    isRebalance: true,
    redemptionPrice: CASE_ORACLE_PRICE,
    icrAfterBps,
  });
}

// Chronological (oldest-first). Debt chain: 25,000.00 borrowed + 12.87
// upfront fee → 25,012.87; +6.50 interest between rows → 25,019.37; five
// hits of −3,690.00 → 6,569.37; +0.13 interest → 6,569.50; adjust
// +2,500.00 + 1.25 fee → 9,070.75. Coll chain: 39,955.00; five hits of
// −4,916.50 → 15,372.50; adjust +30,000.00 → 45,372.50.
const cdpCaseTroveLedgerRowsAsc = [
  caseLedgerRow({
    operation: 0,
    timestamp: caseOpenedAt,
    blockNumber: 20_000_000,
    logIndex: 10,
    txHash: caseTxHash(1),
    collChange: tokenWei(39_955),
    debtChange: tokenWei(25_000),
    upfrontFee: tokenWei(12.87),
    debtBefore: "0",
    debtAfter: tokenWei(25_012.87),
    collBefore: "0",
    collAfter: tokenWei(39_955),
    annualInterestRate: ratePctWei(0.5),
    statusBefore: "closed",
    icrAfterBps: 11980,
  }),
  caseRedemptionRow(0, {
    debtBefore: tokenWei(25_019.37),
    debtAfter: tokenWei(21_329.37),
    collBefore: tokenWei(39_955),
    collAfter: tokenWei(35_038.5),
    icrAfterBps: 12321,
  }),
  caseRedemptionRow(1, {
    debtBefore: tokenWei(21_329.37),
    debtAfter: tokenWei(17_639.37),
    collBefore: tokenWei(35_038.5),
    collAfter: tokenWei(30_122),
    icrAfterBps: 12807,
  }),
  caseRedemptionRow(2, {
    debtBefore: tokenWei(17_639.37),
    debtAfter: tokenWei(13_949.37),
    collBefore: tokenWei(30_122),
    collAfter: tokenWei(25_205.5),
    icrAfterBps: 13552,
  }),
  caseRedemptionRow(3, {
    debtBefore: tokenWei(13_949.37),
    debtAfter: tokenWei(10_259.37),
    collBefore: tokenWei(25_205.5),
    collAfter: tokenWei(20_289),
    icrAfterBps: 14832,
  }),
  caseRedemptionRow(4, {
    debtBefore: tokenWei(10_259.37),
    debtAfter: tokenWei(6_569.37),
    collBefore: tokenWei(20_289),
    collAfter: tokenWei(15_372.5),
    icrAfterBps: 17550,
  }),
  caseLedgerRow({
    operation: 3,
    timestamp: caseRateChangeAt,
    blockNumber: 21_000_000,
    logIndex: 5,
    txHash: caseTxHash(7),
    collChange: "0",
    debtChange: "0",
    debtBefore: tokenWei(6_569.5),
    debtAfter: tokenWei(6_569.5),
    collBefore: tokenWei(15_372.5),
    collAfter: tokenWei(15_372.5),
    annualInterestRate: ratePctWei(1.6),
    icrAfterBps: 17550,
  }),
  caseLedgerRow({
    operation: 2,
    timestamp: caseAdjustAt,
    blockNumber: 21_000_015,
    logIndex: 8,
    txHash: caseTxHash(8),
    collChange: tokenWei(30_000),
    debtChange: tokenWei(2_500),
    upfrontFee: tokenWei(1.25),
    debtBefore: tokenWei(6_569.5),
    debtAfter: tokenWei(9_070.75),
    collBefore: tokenWei(15_372.5),
    collAfter: tokenWei(45_372.5),
    annualInterestRate: ratePctWei(1.6),
    icrAfterBps: 37516,
  }),
];

const cdpCaseTroveLedgerRowsDesc = [...cdpCaseTroveLedgerRowsAsc].reverse();

// The interim user-ops assembly (`CdpTroveOperations`) sees only the
// TroveOperationEvent ordinals (opens/adjusts/rate changes — never op 6).
const cdpCaseTroveUserOpsDesc = cdpCaseTroveLedgerRowsDesc
  .filter((row) => [0, 2, 3].includes(row.operation))
  .map((row) => ({
    id: row.id,
    troveId: CDP_CASE_TROVE_ID,
    operation: row.operation,
    collChange: row.collChange,
    debtChange: row.debtChange,
    annualInterestRate: row.annualInterestRate,
    debtIncreaseFromUpfrontFee: row.debtIncreaseFromUpfrontFee,
    timestamp: row.timestamp,
    blockNumber: row.blockNumber,
    txHash: row.txHash,
  }));

const cdpTroveHistoryCollateral = {
  id: cdpChfmCollateralId,
  chainId: 42220,
  collIndex: 1,
  symbol: "CHFm",
  debtToken: ADDRESSES.celoChfm,
  collToken: ADDRESSES.celoUsdm,
  troveManager: ADDRESSES.celoTroveManagerChfm,
  stabilityPool: ADDRESSES.celoStabilityPoolChfm,
  minDebt: "1000000000000000000000",
  minBoldInSp: "100000000000000000000",
  systemParamsLoaded: true,
  mcrBps: 11000,
  ccrBps: 13500,
  scrBps: 15000,
};

const cdpTroveHistoryInstance = {
  id: cdpChfmCollateralId,
  collateralId: cdpChfmCollateralId,
  chainId: 42220,
  systemColl: tokenWei(74_372.5),
  systemDebt: tokenWei(26_070.75),
  tcrBps: 21395,
  spDeposits: tokenWei(8_000),
  spColl: "0",
  spHeadroom: tokenWei(8_000),
  currentRedemptionRateBps: 50,
  activeTroveCount: 3,
  icrP1Bps: 12500,
  icrP5Bps: 12500,
  icrP50Bps: 13500,
  icrFracBelowMcrBps: 0,
  liqCountCum: 0,
  redemptionCountCum: 5,
  redemptionDebtCum: tokenWei(18_450),
  redemptionFeeCum: tokenWei(12.5),
  rebalanceRedemptionCountCum: 5,
  rebalanceRedemptionDebtCum: tokenWei(18_450),
  rebalanceRedemptionFeeCum: tokenWei(12.5),
  borrowingFeeCum: tokenWei(14.12),
  isShutDown: false,
  shutDownAt: null,
  shutDownTcrBps: null,
  lastEventBlock: "21000015",
  lastEventTimestamp: String(caseAdjustAt),
};

// The case trove's cumulatives equal the op-6 ledger-row sums exactly:
// count 5, debt 5 × 3,690.00, coll 5 × 4,916.50, fees 5 × 2.50 — and the
// current debt/coll equal the newest row's after-snapshots.
const cdpTroveHistoryTroves = [
  {
    id: cdpCaseTroveEntityId,
    collateralId: cdpChfmCollateralId,
    chainId: 42220,
    troveId: CDP_CASE_TROVE_ID,
    owner: ADDRESSES.troveHistoryOwner,
    previousOwner: "0x0000000000000000000000000000000000000000",
    status: "active",
    debt: tokenWei(9_070.75),
    coll: tokenWei(45_372.5),
    icrBps: 37516,
    interestRate: ratePctWei(1.6),
    interestBatchId: null,
    openedAt: String(caseOpenedAt),
    openedTxHash: caseTxHash(1),
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: String(caseAdjustAt),
    lastUpdatedTxHash: caseTxHash(8),
    liquidatedDebt: "0",
    liquidatedColl: "0",
    collSurplus: "0",
    priceAtLiquidation: null,
    redemptionCount: 5,
    redeemedDebt: tokenWei(18_450),
    redeemedColl: tokenWei(24_582.5),
    redemptionFeePaidCum: tokenWei(12.5),
  },
  // The queue-shield trove: 12,000.00 of active debt at a LOWER rate, so the
  // case trove holds position #2 of 3 with a 12,000.00 shield.
  {
    id: `${cdpChfmCollateralId}-0x21`,
    collateralId: cdpChfmCollateralId,
    chainId: 42220,
    troveId: "0x21",
    owner: ADDRESSES.troveOwnerA,
    previousOwner: "0x0000000000000000000000000000000000000000",
    status: "active",
    debt: tokenWei(12_000),
    coll: tokenWei(20_000),
    icrBps: 12500,
    interestRate: ratePctWei(0.9),
    interestBatchId: null,
    openedAt: String(cdpNow - 30 * DAY_SECONDS),
    openedTxHash: caseTxHash(11),
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: String(cdpNow - 3 * DAY_SECONDS),
    lastUpdatedTxHash: caseTxHash(11),
    liquidatedDebt: "0",
    liquidatedColl: "0",
    collSurplus: "0",
    priceAtLiquidation: null,
    redemptionCount: 0,
    redeemedDebt: "0",
    redeemedColl: "0",
    redemptionFeePaidCum: "0",
  },
  // A higher-rate trove so the ladder has a rung after the case trove.
  {
    id: `${cdpChfmCollateralId}-0x22`,
    collateralId: cdpChfmCollateralId,
    chainId: 42220,
    troveId: "0x22",
    owner: ADDRESSES.troveOwnerB,
    previousOwner: "0x0000000000000000000000000000000000000000",
    status: "active",
    debt: tokenWei(5_000),
    coll: tokenWei(9_000),
    icrBps: 13500,
    interestRate: ratePctWei(2.4),
    interestBatchId: null,
    openedAt: String(cdpNow - 20 * DAY_SECONDS),
    openedTxHash: caseTxHash(12),
    closedAt: null,
    closedTxHash: null,
    lastUpdatedAt: String(cdpNow - 4 * DAY_SECONDS),
    lastUpdatedTxHash: caseTxHash(12),
    liquidatedDebt: "0",
    liquidatedColl: "0",
    collSurplus: "0",
    priceAtLiquidation: null,
    redemptionCount: 0,
    redeemedDebt: "0",
    redeemedColl: "0",
    redemptionFeePaidCum: "0",
  },
];

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
  cdpTroveHistoryCollateral,
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
  cdpTroveHistoryInstance,
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
  ...cdpTroveHistoryTroves,
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

const cdpChfmDailySnapshots = [
  {
    id: `${cdpChfmCollateralId}-${stableFixtureToday - DAY_SECONDS}`,
    instanceId: cdpChfmCollateralId,
    timestamp: String(stableFixtureToday - DAY_SECONDS),
    spDeposits: tokenWei(7_500),
    spColl: "0",
    spHeadroom: tokenWei(7_500),
    systemDebt: tokenWei(23_569.5),
    systemColl: tokenWei(44_372.5),
  },
  {
    id: `${cdpChfmCollateralId}-${stableFixtureToday}`,
    instanceId: cdpChfmCollateralId,
    timestamp: String(stableFixtureToday),
    spDeposits: tokenWei(8_000),
    spColl: "0",
    spHeadroom: tokenWei(8_000),
    systemDebt: tokenWei(26_070.75),
    systemColl: tokenWei(74_372.5),
  },
];

const cdpStabilityPoolDepositors = [
  {
    id: `${cdpCollateralId}-${ADDRESSES.stabilityPoolLp}`,
    chainId: 42220,
    collateralId: cdpCollateralId,
    address: ADDRESSES.stabilityPoolLp,
    lastTouchedDeposit: "150000000000000000000",
    stashedColl: "2000000000000000000",
    lastUpdatedAt: String(cdpNow - 120),
    cumulativeDeposited: "210000000000000000000",
    cumulativeWithdrawn: "50000000000000000000",
    cumulativeRebalanceUsed: "8000000000000000000",
    cumulativeLiquidationUsed: "2000000000000000000",
  },
];

const cdpStabilityPoolOperations = [
  {
    id: `${cdpInstanceId}-sp-deposit-1`,
    chainId: 42220,
    instanceId: cdpInstanceId,
    depositor: ADDRESSES.stabilityPoolLp,
    operation: 0,
    depositLossSinceLastOperation: "0",
    topUpOrWithdrawal: "50000000000000000000",
    yieldGainSinceLastOperation: "0",
    yieldGainClaimed: "0",
    ethGainSinceLastOperation: "0",
    ethGainClaimed: "0",
    depositBefore: "100000000000000000000",
    depositAfter: "150000000000000000000",
    stashedCollBefore: "0",
    stashedCollAfter: "2000000000000000000",
    timestamp: String(cdpNow - 500),
    blockNumber: "12345200",
    txHash:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  {
    id: `${cdpInstanceId}-sp-withdraw-1`,
    chainId: 42220,
    instanceId: cdpInstanceId,
    depositor: ADDRESSES.stabilityPoolLp,
    operation: 1,
    depositLossSinceLastOperation: "0",
    topUpOrWithdrawal: "-50000000000000000000",
    yieldGainSinceLastOperation: "0",
    yieldGainClaimed: "0",
    ethGainSinceLastOperation: "0",
    ethGainClaimed: "0",
    depositBefore: "200000000000000000000",
    depositAfter: "150000000000000000000",
    stashedCollBefore: "1000000000000000000",
    stashedCollAfter: "2000000000000000000",
    timestamp: String(cdpNow - 650),
    blockNumber: "12345150",
    txHash:
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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

function cdpStabilityPoolOperationRowsForInstance(instanceId) {
  return cdpStabilityPoolOperations.filter(
    (row) => row.instanceId === String(instanceId),
  );
}

function cdpStabilityPoolOperationRowsForChain(chainId) {
  return cdpStabilityPoolOperations.filter(
    (row) => row.chainId === Number(chainId),
  );
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
    StabilityPoolDepositor: cdpRowsForCollateral(
      cdpStabilityPoolDepositors,
      collateralId,
    ),
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

function fixtureScenario(value) {
  return fixtureServerRuntimeOptions({ scenario: value }).scenario;
}

function poolForScenario(pool, scenario) {
  if (
    scenario !== LIGHTHOUSE_POOL_SCENARIO ||
    pool?.id !== ADDRESSES.celoPool
  ) {
    return pool;
  }
  return {
    ...pool,
    referenceRateFeedID: LIGHTHOUSE_POOL_REFERENCE_RATE_FEED_ID,
  };
}

export function shouldDelayPoolBreakerResponse(
  { query },
  headers,
  clientDelayMs,
) {
  const origin = headers?.origin;
  return (
    Number(clientDelayMs) > 0 &&
    operationName(query ?? "") === "PoolBreakerConfig" &&
    typeof origin === "string" &&
    origin.length > 0
  );
}

function rowsByPoolIds(poolIds) {
  const ids = new Set(poolIds ?? []);
  // The 365d and 366d rows deliberately sit outside the 30d Server Component
  // seed. Projection keeps the latest old row as the TVL forward-fill anchor
  // and drops the older row, preserving the capped-history handoff. Keep both
  // exclusive to the all-history operation so browser tests can prove that
  // selecting "All" performs the client fetch without polluting pool-detail
  // and OG chart fixtures (and their visual snapshots).
  return pools.flatMap((pool) =>
    ids.size === 0 || ids.has(pool.id)
      ? dailySnapshotsFor(pool.id, [0, 1, 2, 365, 366])
      : [],
  );
}

function dailySnapshotLowerBound(variables) {
  return Number(variables.afterTimestamp ?? variables.since ?? 0);
}

export function handleGraphQL(
  { query, variables = {}, scenario: requestScenario },
  scenarioOverride,
) {
  const scenario = fixtureScenario(scenarioOverride ?? requestScenario);
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
    case "BridgeDailySnapshot":
      return { BridgeDailySnapshot: [] };
    case "AllPoolsWithHealth":
      return { Pool: poolRowsForChain(variables.chainId) };
    case "AllPoolsLiveHealth":
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
    case "AllPoolsVpOracleFreshness":
      return {
        Pool: vpOracleFreshnessRows(poolRowsForChain(variables.chainId)),
      };
    case "AllPoolsVpDeprecation":
      return { BiPoolExchange: [] };
    case "AllPoolsVpLifecycleDeprecation":
      return { VirtualPoolLifecycle: [] };
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
    case "AllActivePoolLiquidityStrategies":
    case "PoolLiquidityStrategies":
      return { PoolLiquidityStrategy: [] };
    case "PoolDetailWithHealth": {
      const pool = poolsById.get(String(variables.id));
      return {
        Pool:
          pool && pool.chainId === Number(variables.chainId)
            ? [poolForScenario(pool, scenario)]
            : [],
      };
    }
    case "PoolBreakerConfig":
      if (scenario !== LIGHTHOUSE_POOL_SCENARIO) {
        return unhandledOperation(op);
      }
      return Number(variables.chainId) === 42220 &&
        variables.rateFeedID === LIGHTHOUSE_POOL_REFERENCE_RATE_FEED_ID
        ? lighthousePoolBreakerResponse
        : { BreakerConfig: [], BreakerTripEvent: [] };
    case "PoolRateFeedExt":
      if (scenario !== LIGHTHOUSE_POOL_SCENARIO) {
        return unhandledOperation(op);
      }
      return Number(variables.chainId) === 42220 &&
        String(variables.feedAddress).toLowerCase() ===
          LIGHTHOUSE_POOL_REFERENCE_RATE_FEED_ID
        ? lighthousePoolRateFeedResponse
        : { RateFeed: [] };
    case "PoolThresholdsKnownExt": {
      const pool = poolsById.get(String(variables.id));
      return { Pool: pool ? thresholdRows([pool]) : [] };
    }
    case "PoolBreachRollup": {
      const pool = poolsById.get(String(variables.id));
      return { Pool: pool ? breachRollupRows([pool]) : [] };
    }
    case "PoolHealthCursor": {
      const pool = poolsById.get(String(variables.id));
      return {
        Pool: pool
          ? [
              {
                id: pool.id,
                lastOracleSnapshotTimestamp: null,
                lastDeviationRatio: null,
              },
            ]
          : [],
      };
    }
    case "PoolVpOracleFreshnessExt": {
      const pool = poolsById.get(String(variables.id));
      return { Pool: pool ? vpOracleFreshnessRows([pool]) : [] };
    }
    case "PoolVpDeprecationExt":
      return { BiPoolExchange: [] };
    case "PoolVpLifecycleDeprecationExt":
      return { VirtualPoolLifecycle: [] };
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
      return {
        PoolDailySnapshot: rowsByPoolIds(variables.poolIds).filter(
          (row) => Number(row.timestamp) >= dailySnapshotLowerBound(variables),
        ),
      };
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
    case "OraclePriceDaily":
      return { OraclePriceDailySnapshot: [] };
    case "PoolDailyFeeSnapshotsPage":
      return {
        PoolDailyFeeSnapshot: poolDailyFeeSnapshotsForChain(variables.chainId)
          .filter(
            (row) =>
              Number(row.timestamp) >= Number(variables.afterTimestamp ?? 0),
          )
          .slice(
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
    case "StablesCustodyDailySnapshots":
    case "StablesLatestCustodyPerToken":
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
    case "CdpSchemaFields":
      return {
        TroveType: {
          fields: [
            { name: "id" },
            { name: "lastUpdatedAt" },
            { name: "lastUpdatedTxHash" },
            // Ledger watermark columns: with TroveLedgerEventType below they
            // open the trove history page's introspection gate, so fixture
            // runs exercise the complete-ledger view, not the interim one.
            { name: "lastLedgerBlock" },
            { name: "lastLedgerLogIndex" },
          ],
        },
        StabilityPoolDepositorType: {
          fields: [
            { name: "id" },
            { name: "cumulativeRebalanceUsed" },
            { name: "cumulativeLiquidationUsed" },
          ],
        },
        TroveLedgerEventType: {
          fields: [
            { name: "id" },
            { name: "operation" },
            { name: "debtBefore" },
            { name: "debtAfter" },
            { name: "collBefore" },
            { name: "collAfter" },
            { name: "logIndex" },
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
    case "CdpMarketDetailWithSpSource": {
      const collateralId = String(variables.collateralId);
      return cdpMarketDetailRows(collateralId);
    }
    case "CdpMarketDetailWithTroveTxAndSpSource": {
      const collateralId = String(variables.collateralId);
      return cdpMarketDetailRows(collateralId);
    }
    case "CdpInstanceDailySnapshots":
      return {
        LiquityInstanceDailySnapshot:
          String(variables.instanceId) === cdpInstanceId
            ? cdpDailySnapshots
            : String(variables.instanceId) === cdpChfmCollateralId
              ? cdpChfmDailySnapshots
              : [],
      };
    case "CdpTransactions":
      return cdpTransactions;
    case "AllCdpTransactions":
      return {
        LiquidationEvent: cdpTransactions.LiquidationEvent.slice(
          0,
          variables.limit ?? cdpTransactions.LiquidationEvent.length,
        ),
        RedemptionEvent: cdpTransactions.RedemptionEvent.slice(
          0,
          variables.limit ?? cdpTransactions.RedemptionEvent.length,
        ),
        SpRebalanceEvent: cdpTransactions.SpRebalanceEvent.slice(
          0,
          variables.limit ?? cdpTransactions.SpRebalanceEvent.length,
        ),
        TroveOperationEvent: cdpTransactions.TroveOperationEvent.slice(
          0,
          variables.limit ?? cdpTransactions.TroveOperationEvent.length,
        ),
      };
    case "CdpStabilityPoolEvents":
      return {
        StabilityPoolOperationEvent: cdpStabilityPoolOperationRowsForInstance(
          variables.instanceId,
        ).slice(0, variables.limit ?? cdpStabilityPoolOperations.length),
      };
    case "AllCdpStabilityPoolEvents":
      return {
        StabilityPoolOperationEvent: cdpStabilityPoolOperationRowsForChain(
          variables.chainId,
        ).slice(0, variables.limit ?? cdpStabilityPoolOperations.length),
      };
    case "CdpTroveOpSnapshots":
      return { TroveOperationEvent: cdpTroveOpSnapshots };
    case "AllCdpTroveOpSnapshots":
      return { TroveOperationEvent: cdpTroveOpSnapshots };
    case "CdpTroveById":
    case "CdpTroveByIdWithoutTx":
      return {
        Trove: cdpTroves.filter(
          (trove) => trove.id === String(variables.troveEntityId),
        ),
      };
    case "CdpInterestBatchById":
      return {
        InterestBatch: cdpInterestBatches.filter(
          (batch) => batch.id === String(variables.batchId),
        ),
      };
    // Interim user-ops assembly — fires on a cold trove-page load while the
    // schema probe is still resolving, then hands over to CdpTroveLedger.
    case "CdpTroveOperations":
      return {
        TroveOperationEvent:
          String(variables.instanceId) === cdpChfmCollateralId &&
          String(variables.troveId) === CDP_CASE_TROVE_ID
            ? cdpCaseTroveUserOpsDesc.slice(
                0,
                variables.limit ?? cdpCaseTroveUserOpsDesc.length,
              )
            : [],
      };
    case "CdpTroveLedger": {
      const troveEntityId = String(variables.troveEntityId);
      const trove = cdpTroves.find((row) => row.id === troveEntityId);
      if (trove == null) {
        return { LedgerWatermark: [], TroveLedgerEvent: [] };
      }
      const rows =
        troveEntityId === cdpCaseTroveEntityId
          ? cdpCaseTroveLedgerRowsDesc
          : [];
      const newest = rows[0];
      return {
        // Watermark and cumulatives come from the SAME response as the rows
        // — the newest row's (blockNumber, logIndex) pair anchors the impact
        // panel's reconciliation. A trove with no ledger rows reports the
        // "(0, 0) — no ledger row yet" watermark.
        LedgerWatermark: [
          {
            lastLedgerBlock: newest?.blockNumber ?? "0",
            lastLedgerLogIndex: newest?.logIndex ?? 0,
            redemptionCount: trove.redemptionCount ?? 0,
            redeemedDebt: trove.redeemedDebt ?? "0",
            redeemedColl: trove.redeemedColl ?? "0",
            redemptionFeePaidCum: trove.redemptionFeePaidCum ?? "0",
          },
        ],
        TroveLedgerEvent: rows.slice(0, variables.limit ?? rows.length),
      };
    }
    case "CdpTroveQueue": {
      const collateralId = String(variables.collateralId);
      return {
        LiquityInstance: cdpRowsForCollateral(cdpInstances, collateralId).map(
          ({ id, isShutDown, shutDownAt }) => ({ id, isShutDown, shutDownAt }),
        ),
        OpenTrove: cdpRowsForCollateral(cdpTroves, collateralId)
          .filter((trove) => ["active", "zombie"].includes(trove.status))
          .map(({ id, status, debt, interestRate, interestBatchId }) => ({
            id,
            status,
            debt,
            interestRate,
            interestBatchId: interestBatchId ?? null,
          })),
        InterestBatch: cdpRowsForCollateral(
          cdpInterestBatches,
          collateralId,
        ).map(({ id, annualInterestRate }) => ({ id, annualInterestRate })),
      };
    }
    case "CdpTrovesByOwner": {
      const address = String(variables.address).toLowerCase();
      return {
        Trove: cdpTroves
          .filter(
            (trove) =>
              trove.chainId === Number(variables.chainId) &&
              (trove.owner === address || trove.previousOwner === address),
          )
          .map(
            ({
              id,
              collateralId,
              troveId,
              status,
              debt,
              coll,
              lastUpdatedAt,
            }) => ({
              id,
              collateralId,
              troveId,
              status,
              debt,
              coll,
              lastUpdatedAt,
            }),
          )
          .slice(0, variables.limit ?? cdpTroves.length),
      };
    }
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

export function fixtureHealthResponse({
  requestedIdentity,
  fixtureServerIdentity,
  errorCount = 0,
  delayedPoolBreakerCount = 0,
}) {
  const identityMatches =
    requestedIdentity === null || requestedIdentity === fixtureServerIdentity;
  return {
    status: identityMatches ? 200 : 409,
    body: {
      ok: true,
      fixtureServerIdentity,
      errorCount,
      delayedPoolBreakerCount,
    },
  };
}

export async function startFixtureServer(
  port,
  {
    scenario = process.env.HASURA_FIXTURE_SCENARIO,
    clientDelayMs = process.env.HASURA_FIXTURE_CLIENT_DELAY_MS,
  } = {},
) {
  const { scenario: activeScenario, clientDelayMs: activeClientDelayMs } =
    fixtureServerRuntimeOptions({ scenario, clientDelayMs });
  const fixtureServerIdentity = await currentFixtureServerIdentity({
    scenario: activeScenario,
    clientDelayMs: activeClientDelayMs,
  });
  let errorCount = 0;
  let delayedPoolBreakerCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (
      requestUrl.pathname === "/health" ||
      requestUrl.pathname.startsWith("/health/")
    ) {
      const requestedIdentity =
        requestUrl.pathname === "/health"
          ? null
          : requestUrl.pathname.slice("/health/".length);
      const health = fixtureHealthResponse({
        requestedIdentity,
        fixtureServerIdentity,
        errorCount,
        delayedPoolBreakerCount,
      });
      sendJson(res, health.status, health.body);
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
        const result = handleGraphQL(body, activeScenario);
        const respond = () => {
          if (result.__fixtureErrors) {
            errorCount += result.__fixtureErrors.length;
            sendJson(res, 200, { errors: result.__fixtureErrors });
            return;
          }
          sendJson(res, 200, { data: result });
        };
        const shouldDelay = shouldDelayPoolBreakerResponse(
          body,
          req.headers,
          activeClientDelayMs,
        );
        if (shouldDelay) {
          setTimeout(() => {
            respond();
            delayedPoolBreakerCount += 1;
          }, activeClientDelayMs);
        } else {
          respond();
        }
      } catch (error) {
        errorCount += 1;
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

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const activePort = typeof address === "object" ? address?.port : port;
      process.stdout.write(
        `Hasura fixture server listening on ${activePort} (${activeScenario})\n`,
      );
      resolvePromise();
    });
  });
  return { server, fixtureServerIdentity, activeScenario, activeClientDelayMs };
}

if (isMain) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "3211" },
    },
  });

  const { server } = await startFixtureServer(Number(values.port));
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
}
