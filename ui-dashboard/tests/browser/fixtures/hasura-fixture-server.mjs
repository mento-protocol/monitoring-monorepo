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
  celoBrlm: "0x0000000000000000000000000000000000000b71",
  monadAusd: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
  monadUsdm: "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115",
  lp: "0x1111111111111111111111111111111111111111",
  trader: "0x2222222222222222222222222222222222222222",
  recipient: "0x3333333333333333333333333333333333333333",
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
  ];
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
    case "AllPoolsWithHealth":
      return { Pool: poolRowsForChain(variables.chainId) };
    case "OracleRates":
      return { Pool: oracleRateRowsForChain(variables.chainId) };
    case "AllPoolsRebalanceThresholdsKnown":
      return { Pool: thresholdRows(poolRowsForChain(variables.chainId)) };
    case "AllPoolsBreachRollup":
      return { Pool: breachRollupRows(poolRowsForChain(variables.chainId)) };
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
      return { PoolDailyFeeSnapshot: [] };
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
    case "StablesLatestPerToken":
      return {
        StableSupplyDailySnapshot: [
          stableDailySnapshots[1],
          stableDailySnapshots[3],
        ],
      };
    case "StablesDailySnapshots":
      return { StableSupplyDailySnapshot: stableDailySnapshots };
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
