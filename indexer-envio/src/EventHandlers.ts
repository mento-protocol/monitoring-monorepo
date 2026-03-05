import {
  FPMMFactory,
  FPMM,
  Pool,
  PoolSnapshot,
  OracleSnapshot,
  FactoryDeployment,
  LiquidityEvent,
  RebalanceEvent,
  ReserveUpdate,
  SwapEvent,
  VirtualPoolFactory,
  VirtualPool,
  VirtualPoolLifecycle,
  SortedOracles,
} from "generated";

import { createPublicClient, http } from "viem";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const eventId = (
  chainId: number,
  blockNumber: number,
  logIndex: number,
): string => `${chainId}_${blockNumber}_${logIndex}`;

const asAddress = (value: string): string => value.toLowerCase();
const asBigInt = (value: number): bigint => BigInt(value);

const SECONDS_PER_HOUR = 3600n;

/** Round a unix timestamp down to the start of its hour. */
const hourBucket = (timestamp: bigint): bigint =>
  (timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;

/** Deterministic snapshot ID: "{poolId}-{hourTimestamp}" */
const snapshotId = (poolId: string, hourTs: bigint): string =>
  `${poolId}-${hourTs}`;

// ---------------------------------------------------------------------------
// Oracle helpers
// ---------------------------------------------------------------------------

/** In-memory mapping: rateFeedID (lowercase) → poolId for FPMM pools */
const rateFeedPoolMap = new Map<string, string>();

// Lazy RPC clients per chainId
const rpcClients = new Map<number, ReturnType<typeof createPublicClient>>();

function getRpcClient(chainId: number): ReturnType<typeof createPublicClient> {
  if (!rpcClients.has(chainId)) {
    const defaultRpc =
      chainId === 42220
        ? "https://forno.celo.org"
        : "https://forno.celo-sepolia.celo-testnet.org";
    rpcClients.set(
      chainId,
      createPublicClient({
        transport: http(process.env.ENVIO_RPC_URL ?? defaultRpc, {
          batch: true,
        }),
      }),
    );
  }
  return rpcClients.get(chainId)!;
}

const FPMM_MINIMAL_ABI = [
  {
    type: "function",
    name: "getRebalancingState",
    inputs: [],
    outputs: [
      { name: "oraclePriceNumerator", type: "uint256" },
      { name: "oraclePriceDenominator", type: "uint256" },
      { name: "reservePriceNumerator", type: "uint256" },
      { name: "reservePriceDenominator", type: "uint256" },
      { name: "reservePriceAboveOraclePrice", type: "bool" },
      { name: "rebalanceThreshold", type: "uint16" },
      { name: "priceDifference", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "referenceRateFeedID",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

type RebalancingState = {
  oraclePriceNumerator: bigint;
  oraclePriceDenominator: bigint;
  rebalanceThreshold: number;
  priceDifference: bigint;
};

async function fetchRebalancingState(
  chainId: number,
  poolAddress: string,
): Promise<RebalancingState | null> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "getRebalancingState",
    });
    // viem returns a tuple: [num, denom, rNum, rDenom, above, threshold, diff]
    const r = result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
      number,
      bigint,
    ];
    return {
      oraclePriceNumerator: r[0],
      oraclePriceDenominator: r[1],
      rebalanceThreshold: Number(r[5]),
      priceDifference: r[6],
    };
  } catch {
    return null;
  }
}

async function fetchReferenceRateFeedID(
  chainId: number,
  poolAddress: string,
): Promise<string | null> {
  try {
    const client = getRpcClient(chainId);
    const result = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: FPMM_MINIMAL_ABI,
      functionName: "referenceRateFeedID",
    });
    return (result as string).toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health status computation
// ---------------------------------------------------------------------------

function computeHealthStatus(pool: Pool): string {
  if (pool.source?.includes("virtual")) return "N/A";
  if (!pool.oracleOk) return "CRITICAL";
  const threshold = pool.rebalanceThreshold > 0 ? pool.rebalanceThreshold : 10000;
  const devRatio = Number(pool.priceDifference) / threshold;
  if (devRatio >= 1.0) return "CRITICAL";
  if (devRatio >= 0.8) return "WARN";
  return "OK";
}

// ---------------------------------------------------------------------------
// Pool upsert (with cumulative fields)
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY: Record<string, number> = {
  virtual_pool_factory: 100,
  fpmm_factory: 90,
  fpmm_rebalanced: 50,
  fpmm_update_reserves: 40,
  fpmm_swap: 30,
  fpmm_mint: 20,
  fpmm_burn: 20,
};

const pickPreferredSource = (
  existingSource: string | undefined,
  incomingSource: string,
): string => {
  if (!existingSource) return incomingSource;
  const existingPriority = SOURCE_PRIORITY[existingSource] ?? 0;
  const incomingPriority = SOURCE_PRIORITY[incomingSource] ?? 0;
  return incomingPriority >= existingPriority ? incomingSource : existingSource;
};

type PoolContext = {
  Pool: {
    get: (id: string) => Promise<Pool | undefined>;
    set: (entity: Pool) => void;
  };
};

type SnapshotContext = {
  PoolSnapshot: {
    get: (id: string) => Promise<PoolSnapshot | undefined>;
    set: (entity: PoolSnapshot) => void;
  };
};

/** Default oracle field values (for VirtualPools or when RPC call fails) */
const DEFAULT_ORACLE_FIELDS = {
  oracleOk: false,
  oraclePrice: 0n,
  oraclePriceDenom: 0n,
  oracleTimestamp: 0n,
  oracleExpiry: 0n,
  oracleNumReporters: 0,
  referenceRateFeedID: "",
  priceDifference: 0n,
  rebalanceThreshold: 0,
  lastRebalancedAt: 0n,
  healthStatus: "N/A" as string,
};

const getOrCreatePool = async (
  context: PoolContext,
  poolId: string,
  defaults?: { token0?: string; token1?: string },
): Promise<Pool> => {
  const existing = await context.Pool.get(poolId);
  if (existing) return existing;
  return {
    id: poolId,
    token0: defaults?.token0,
    token1: defaults?.token1,
    source: "",
    reserves0: 0n,
    reserves1: 0n,
    swapCount: 0,
    notionalVolume0: 0n,
    notionalVolume1: 0n,
    rebalanceCount: 0,
    ...DEFAULT_ORACLE_FIELDS,
    createdAtBlock: 0n,
    createdAtTimestamp: 0n,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
  };
};

const upsertPool = async ({
  context,
  poolId,
  token0,
  token1,
  source,
  blockNumber,
  blockTimestamp,
  reservesDelta,
  swapDelta,
  rebalanceDelta,
  oracleDelta,
}: {
  context: PoolContext;
  poolId: string;
  token0?: string;
  token1?: string;
  source: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  reservesDelta?: { reserve0: bigint; reserve1: bigint };
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  oracleDelta?: Partial<typeof DEFAULT_ORACLE_FIELDS>;
}): Promise<Pool> => {
  const existing = await getOrCreatePool(context, poolId, { token0, token1 });

  const next: Pool = {
    ...existing,
    token0: token0 ?? existing.token0,
    token1: token1 ?? existing.token1,
    source: pickPreferredSource(existing.source, source),
    reserves0: reservesDelta?.reserve0 ?? existing.reserves0,
    reserves1: reservesDelta?.reserve1 ?? existing.reserves1,
    swapCount: existing.swapCount + (swapDelta ? 1 : 0),
    notionalVolume0: existing.notionalVolume0 + (swapDelta?.volume0 ?? 0n),
    notionalVolume1: existing.notionalVolume1 + (swapDelta?.volume1 ?? 0n),
    rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
    // Merge oracle delta if provided
    ...(oracleDelta ?? {}),
    createdAtBlock:
      existing.createdAtBlock === 0n ? blockNumber : existing.createdAtBlock,
    createdAtTimestamp:
      existing.createdAtTimestamp === 0n
        ? blockTimestamp
        : existing.createdAtTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };

  context.Pool.set(next);
  return next;
};

// ---------------------------------------------------------------------------
// PoolSnapshot upsert
// ---------------------------------------------------------------------------

const upsertSnapshot = async ({
  context,
  pool,
  blockTimestamp,
  blockNumber,
  swapDelta,
  rebalanceDelta,
  mintDelta,
  burnDelta,
}: {
  context: SnapshotContext;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  mintDelta?: boolean;
  burnDelta?: boolean;
}): Promise<void> => {
  const hourTs = hourBucket(blockTimestamp);
  const id = snapshotId(pool.id, hourTs);
  const existing = await context.PoolSnapshot.get(id);

  const snapshot: PoolSnapshot = existing
    ? {
        ...existing,
        // Update point-in-time state to latest
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        // Increment per-hour counters
        swapCount: existing.swapCount + (swapDelta ? 1 : 0),
        swapVolume0: existing.swapVolume0 + (swapDelta?.volume0 ?? 0n),
        swapVolume1: existing.swapVolume1 + (swapDelta?.volume1 ?? 0n),
        rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
        mintCount: existing.mintCount + (mintDelta ? 1 : 0),
        burnCount: existing.burnCount + (burnDelta ? 1 : 0),
        // Snapshot of pool running totals
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      }
    : {
        id,
        poolId: pool.id,
        timestamp: hourTs,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: swapDelta ? 1 : 0,
        swapVolume0: swapDelta?.volume0 ?? 0n,
        swapVolume1: swapDelta?.volume1 ?? 0n,
        rebalanceCount: rebalanceDelta ? 1 : 0,
        mintCount: mintDelta ? 1 : 0,
        burnCount: burnDelta ? 1 : 0,
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      };

  context.PoolSnapshot.set(snapshot);
};

// ---------------------------------------------------------------------------
// Event Handlers — FPMM
// ---------------------------------------------------------------------------

FPMMFactory.FPMMDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.fpmmProxy);
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch oracle state from chain at pool creation
  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};

  const [rateFeedID, rebalState] = await Promise.all([
    fetchReferenceRateFeedID(event.chainId, poolId),
    fetchRebalancingState(event.chainId, poolId),
  ]);

  if (rateFeedID) {
    oracleDelta.referenceRateFeedID = rateFeedID;
    // Register in the in-memory map for SortedOracles event lookup
    rateFeedPoolMap.set(rateFeedID, poolId);
  }

  if (rebalState) {
    oracleDelta.oraclePrice = rebalState.oraclePriceNumerator;
    oracleDelta.oraclePriceDenom = rebalState.oraclePriceDenominator;
    oracleDelta.rebalanceThreshold = rebalState.rebalanceThreshold;
    oracleDelta.priceDifference = rebalState.priceDifference;
    // Assume oracle is OK when pool is first deployed
    oracleDelta.oracleOk = true;
    oracleDelta.oracleTimestamp = blockTimestamp;
  }

  const pool = await upsertPool({
    context,
    poolId,
    token0,
    token1,
    source: "fpmm_factory",
    blockNumber,
    blockTimestamp,
    oracleDelta,
  });

  // Compute and persist healthStatus
  const healthStatus = computeHealthStatus({ ...pool, ...oracleDelta });
  context.Pool.set({ ...pool, ...oracleDelta, healthStatus });

  const deployment: FactoryDeployment = {
    id,
    poolId,
    token0,
    token1,
    implementation: asAddress(event.params.fpmmImplementation),
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.FactoryDeployment.set(deployment);
});

FPMM.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Compute volume: max of in/out for each token side
  const volume0 =
    event.params.amount0In > event.params.amount0Out
      ? event.params.amount0In
      : event.params.amount0Out;
  const volume1 =
    event.params.amount1In > event.params.amount1Out
      ? event.params.amount1In
      : event.params.amount1Out;

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_swap",
    blockNumber,
    blockTimestamp,
    swapDelta: { volume0, volume1 },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    swapDelta: { volume0, volume1 },
  });

  const swap: SwapEvent = {
    id,
    poolId,
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0In: event.params.amount0In,
    amount1In: event.params.amount1In,
    amount0Out: event.params.amount0Out,
    amount1Out: event.params.amount1Out,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.SwapEvent.set(swap);
});

FPMM.Mint.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_mint",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    mintDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "MINT",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

FPMM.Burn.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_burn",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    burnDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "BURN",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

FPMM.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch fresh rebalancing state for FPMM pools
  const rebalState = await fetchRebalancingState(event.chainId, poolId);

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};
  if (rebalState) {
    oracleDelta = {
      oraclePrice: rebalState.oraclePriceNumerator,
      oraclePriceDenom: rebalState.oraclePriceDenominator,
      rebalanceThreshold: rebalState.rebalanceThreshold,
      priceDifference: rebalState.priceDifference,
      oracleTimestamp: blockTimestamp,
    };
  }

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_update_reserves",
    blockNumber,
    blockTimestamp,
    reservesDelta: {
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    },
    oracleDelta,
  });

  // Update healthStatus based on latest oracle state
  const updatedPool: Pool = {
    ...pool,
    ...oracleDelta,
  };
  const healthStatus = computeHealthStatus(updatedPool);
  context.Pool.set({ ...updatedPool, healthStatus });

  // Create OracleSnapshot if we got data
  if (rebalState) {
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: rebalState.oraclePriceNumerator,
      oraclePriceDenom: rebalState.oraclePriceDenominator,
      oracleOk: updatedPool.oracleOk,
      numReporters: updatedPool.oracleNumReporters,
      priceDifference: rebalState.priceDifference,
      rebalanceThreshold: rebalState.rebalanceThreshold,
      source: "update_reserves",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }

  await upsertSnapshot({
    context,
    pool: { ...updatedPool, healthStatus },
    blockTimestamp,
    blockNumber,
  });

  const reserveUpdate: ReserveUpdate = {
    id,
    poolId,
    reserve0: event.params.reserve0,
    reserve1: event.params.reserve1,
    blockTimestampInPool: event.params.blockTimestamp,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.ReserveUpdate.set(reserveUpdate);
});

FPMM.Rebalanced.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch fresh rebalancing state post-rebalance
  const rebalState = await fetchRebalancingState(event.chainId, poolId);

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {
    lastRebalancedAt: blockTimestamp,
  };

  if (rebalState) {
    oracleDelta = {
      ...oracleDelta,
      oraclePrice: rebalState.oraclePriceNumerator,
      oraclePriceDenom: rebalState.oraclePriceDenominator,
      rebalanceThreshold: rebalState.rebalanceThreshold,
      priceDifference: rebalState.priceDifference,
      oracleTimestamp: blockTimestamp,
    };
  }

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    rebalanceDelta: true,
    oracleDelta,
  });

  const updatedPool: Pool = {
    ...pool,
    ...oracleDelta,
  };
  const healthStatus = computeHealthStatus(updatedPool);
  context.Pool.set({ ...updatedPool, healthStatus });

  // Create OracleSnapshot
  if (rebalState) {
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: rebalState.oraclePriceNumerator,
      oraclePriceDenom: rebalState.oraclePriceDenominator,
      oracleOk: updatedPool.oracleOk,
      numReporters: updatedPool.oracleNumReporters,
      priceDifference: rebalState.priceDifference,
      rebalanceThreshold: rebalState.rebalanceThreshold,
      source: "rebalanced",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }

  await upsertSnapshot({
    context,
    pool: { ...updatedPool, healthStatus },
    blockTimestamp,
    blockNumber,
    rebalanceDelta: true,
  });

  const rebalanced: RebalanceEvent = {
    id,
    poolId,
    sender: asAddress(event.params.sender),
    priceDifferenceBefore: event.params.priceDifferenceBefore,
    priceDifferenceAfter: event.params.priceDifferenceAfter,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});

// ---------------------------------------------------------------------------
// Event Handlers — SortedOracles (Mainnet only)
// ---------------------------------------------------------------------------

SortedOracles.OracleReported.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Look up which pool uses this rateFeedID
  const poolId = rateFeedPoolMap.get(rateFeedID);
  if (!poolId) return; // No pool tracks this rateFeedID

  const existing = await context.Pool.get(poolId);
  if (!existing) return;

  // OracleReported includes: token (rateFeedID), oracle (reporter), timestamp, value
  // value is the reported price, timestamp is the oracle's reported timestamp
  const oracleTimestamp = event.params.timestamp;
  const oraclePrice = event.params.value;

  const oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {
    oracleTimestamp,
    oracleOk: true, // A new report means oracle is fresh
    oraclePrice,
    // Keep existing denom (we'll update on MedianUpdated)
  };

  const updatedPool: Pool = {
    ...existing,
    ...oracleDelta,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  const healthStatus = computeHealthStatus(updatedPool);
  context.Pool.set({ ...updatedPool, healthStatus });

  // Create OracleSnapshot
  const snapshot: OracleSnapshot = {
    id: eventId(event.chainId, event.block.number, event.logIndex),
    poolId,
    timestamp: blockTimestamp,
    oraclePrice,
    oraclePriceDenom: existing.oraclePriceDenom,
    oracleOk: true,
    numReporters: existing.oracleNumReporters,
    priceDifference: existing.priceDifference,
    rebalanceThreshold: existing.rebalanceThreshold,
    source: "oracle_reported",
    blockNumber,
  };
  context.OracleSnapshot.set(snapshot);
});

SortedOracles.MedianUpdated.handler(async ({ event, context }) => {
  const rateFeedID = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Look up which pool uses this rateFeedID
  const poolId = rateFeedPoolMap.get(rateFeedID);
  if (!poolId) return;

  const existing = await context.Pool.get(poolId);
  if (!existing) return;

  // MedianUpdated includes: token (rateFeedID), value (new median price)
  const oraclePrice = event.params.value;

  const updatedPool: Pool = {
    ...existing,
    oraclePrice,
    oracleTimestamp: blockTimestamp,
    oracleOk: true,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  const healthStatus = computeHealthStatus(updatedPool);
  context.Pool.set({ ...updatedPool, healthStatus });

  // Create OracleSnapshot for median update
  const snapshot: OracleSnapshot = {
    id: eventId(event.chainId, event.block.number, event.logIndex),
    poolId,
    timestamp: blockTimestamp,
    oraclePrice,
    oraclePriceDenom: existing.oraclePriceDenom,
    oracleOk: true,
    numReporters: existing.oracleNumReporters,
    priceDifference: existing.priceDifference,
    rebalanceThreshold: existing.rebalanceThreshold,
    source: "oracle_reported",
    blockNumber,
  };
  context.OracleSnapshot.set(snapshot);
});

// ---------------------------------------------------------------------------
// Event Handlers — VirtualPoolFactory
// ---------------------------------------------------------------------------

VirtualPoolFactory.VirtualPoolDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);

  // VirtualPools don't have oracle functions; set N/A health status
  await upsertPool({
    context,
    poolId,
    token0,
    token1,
    source: "virtual_pool_factory",
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
    oracleDelta: {
      ...DEFAULT_ORACLE_FIELDS,
      healthStatus: "N/A",
    },
  });

  const lifecycle: VirtualPoolLifecycle = {
    id,
    poolId,
    action: "DEPLOYED",
    token0,
    token1,
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
  };

  context.VirtualPoolLifecycle.set(lifecycle);
});

VirtualPoolFactory.PoolDeprecated.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);

  await upsertPool({
    context,
    poolId,
    source: "virtual_pool_factory",
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
  });

  const lifecycle: VirtualPoolLifecycle = {
    id,
    poolId,
    action: "DEPRECATED",
    token0: undefined,
    token1: undefined,
    factoryAddress: asAddress(event.srcAddress),
    txHash: event.transaction.hash,
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
  };

  context.VirtualPoolLifecycle.set(lifecycle);
});

// ---------------------------------------------------------------------------
// Event Handlers — VirtualPool (swap/reserve tracking; no oracle)
// ---------------------------------------------------------------------------

VirtualPool.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const volume0 =
    event.params.amount0In > event.params.amount0Out
      ? event.params.amount0In
      : event.params.amount0Out;
  const volume1 =
    event.params.amount1In > event.params.amount1Out
      ? event.params.amount1In
      : event.params.amount1Out;

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_swap", // reuse source key; VirtualPool inherits same priority
    blockNumber,
    blockTimestamp,
    swapDelta: { volume0, volume1 },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    swapDelta: { volume0, volume1 },
  });

  const swap: SwapEvent = {
    id,
    poolId,
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0In: event.params.amount0In,
    amount1In: event.params.amount1In,
    amount0Out: event.params.amount0Out,
    amount1Out: event.params.amount1Out,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.SwapEvent.set(swap);
});

VirtualPool.Mint.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_mint",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    mintDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "MINT",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

VirtualPool.Burn.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_burn",
    blockNumber,
    blockTimestamp,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    burnDelta: true,
  });

  const liquidityEvent: LiquidityEvent = {
    id,
    poolId,
    kind: "BURN",
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    liquidity: event.params.liquidity,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.LiquidityEvent.set(liquidityEvent);
});

VirtualPool.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // VirtualPools have no oracle; just update reserves
  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_update_reserves",
    blockNumber,
    blockTimestamp,
    reservesDelta: {
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
  });

  const reserveUpdate: ReserveUpdate = {
    id,
    poolId,
    reserve0: event.params.reserve0,
    reserve1: event.params.reserve1,
    blockTimestampInPool: event.params.blockTimestamp,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.ReserveUpdate.set(reserveUpdate);
});

VirtualPool.Rebalanced.handler(async ({ event, context }) => {
  // VirtualPools shouldn't normally rebalance, but handle defensively
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    rebalanceDelta: true,
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    rebalanceDelta: true,
  });

  const rebalanced: RebalanceEvent = {
    id,
    poolId,
    sender: asAddress(event.params.sender),
    priceDifferenceBefore: event.params.priceDifferenceBefore,
    priceDifferenceAfter: event.params.priceDifferenceAfter,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});

// ---------------------------------------------------------------------------
// Gap-Filling Note:
// ---------------------------------------------------------------------------
// Block handlers in Envio don't provide block.timestamp (only number/chainId).
// For true hourly snapshots during quiet periods, options are:
// 1. External cron job that queries chain and writes to DB
// 2. Envio ClickHouse sink (roadmap)
// 3. Dashboard-side forward-fill (simplest for now)
//
// Current approach: Event-driven snapshots + forward-fill in dashboard charts.
