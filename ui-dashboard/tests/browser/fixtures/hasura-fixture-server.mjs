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

function poolRowsForChain(chainId) {
  return pools.filter((pool) => pool.chainId === Number(chainId));
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
    case "OracleRates":
      return { Pool: poolRowsForChain(variables.chainId) };
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
    case "PoolDailyFeeSnapshotsPage":
      return { PoolDailyFeeSnapshot: [] };
    case "BrokerDailySnapshotsAll":
      return { BrokerDailySnapshot: [] };
    case "AllTradingLimits":
    case "TradingLimits":
      return { TradingLimit: [] };
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
    default:
      return {};
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
      sendJson(res, 200, { data: handleGraphQL(body) });
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
