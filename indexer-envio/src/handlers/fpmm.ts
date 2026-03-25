// ---------------------------------------------------------------------------
// FPMM and FPMMFactory event handlers
// ---------------------------------------------------------------------------

import {
  FPMMFactory,
  FPMM,
  type Pool,
  type FactoryDeployment,
  type SwapEvent,
  type SwapTxIndex,
  type LiquidityEvent,
  type ReserveUpdate,
  type RebalanceEvent,
  type OracleSnapshot,
  type TradingLimit,
} from "generated";
import { eventId, asAddress, asBigInt } from "../helpers";
import {
  scalingFactorToDecimals,
  ORACLE_ADAPTER_SCALE_FACTOR,
} from "../priceDifference";
import {
  TRADING_LIMITS_INTERNAL_DECIMALS,
  computeLimitPressures,
  computeLimitStatus,
} from "../tradingLimits";
import {
  fetchRebalancingState,
  fetchInvertRateFeed,
  fetchRebalanceThreshold,
  fetchReferenceRateFeedID,
  fetchTokenDecimalsScaling,
  fetchReportExpiry,
  fetchNumReporters,
  fetchTradingLimits,
} from "../rpc";
import { upsertPool, upsertSnapshot, DEFAULT_ORACLE_FIELDS } from "../pool";
import { hourBucket, snapshotId } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Called from Mint/Burn handlers to mark the co-transaction Swap (if any) as
 * an LP-rebalance swap and subtract its volume from the pool / snapshot
 * cumulative trade metrics.
 *
 * Envio guarantees log-order processing within a block, so by the time
 * Mint/Burn fires the Swap handler has already run and written:
 *   - SwapEvent (with isLpSwap: false)
 *   - SwapTxIndex ("{chainId}:{poolId}:{txHash}" → swapEventId)
 *   - Pool.swapCount / notionalVolume0/1 (already incremented)
 *   - PoolSnapshot.swapCount / swapVolume0/1 (already incremented)
 *
 * We undo those increments here so that all cumulative metrics reflect only
 * genuine user trades.
 */
// Minimal interface for the context object needed by backfillLpSwap.
// The full generated context type is a superset of this.
interface BackfillContext {
  SwapTxIndex: {
    get(id: string): Promise<{ swapEventId: string } | undefined>;
  };
  SwapEvent: {
    get(id: string): Promise<SwapEvent | undefined>;
    set(entity: SwapEvent): void;
  };
  Pool: {
    get(id: string): Promise<Pool | undefined>;
    set(entity: Pool): void;
  };
  PoolSnapshot: {
    get(id: string): Promise<
      | {
          swapCount: number;
          swapVolume0: bigint;
          swapVolume1: bigint;
          cumulativeSwapCount: number;
          cumulativeVolume0: bigint;
          cumulativeVolume1: bigint;
          [key: string]: unknown;
        }
      | undefined
    >;
    set(entity: unknown): void;
  };
}

async function backfillLpSwap({
  context,
  chainId,
  poolId,
  txHash,
  blockTimestamp,
}: {
  context: BackfillContext;
  chainId: number;
  poolId: string;
  txHash: string;
  blockTimestamp: bigint;
}): Promise<void> {
  const indexId = `${chainId}:${poolId}:${txHash}`;
  const swapIndex = await context.SwapTxIndex.get(indexId);
  if (!swapIndex) return; // No swap in this tx — nothing to backfill

  const existingSwap = await context.SwapEvent.get(swapIndex.swapEventId);
  if (!existingSwap) return;

  // Mark the swap as LP-triggered
  context.SwapEvent.set({ ...existingSwap, isLpSwap: true });

  // Compute the volume that was incorrectly attributed to user trades
  const lpVol0 =
    existingSwap.amount0In > existingSwap.amount0Out
      ? existingSwap.amount0In
      : existingSwap.amount0Out;
  const lpVol1 =
    existingSwap.amount1In > existingSwap.amount1Out
      ? existingSwap.amount1In
      : existingSwap.amount1Out;

  // Subtract from Pool cumulative trade metrics
  const pool = await context.Pool.get(poolId);
  if (pool) {
    context.Pool.set({
      ...pool,
      swapCount: Math.max(0, pool.swapCount - 1),
      notionalVolume0:
        pool.notionalVolume0 > lpVol0 ? pool.notionalVolume0 - lpVol0 : 0n,
      notionalVolume1:
        pool.notionalVolume1 > lpVol1 ? pool.notionalVolume1 - lpVol1 : 0n,
    });
  }

  // Subtract from the PoolSnapshot bucket that the Swap handler wrote into.
  // Also correct the cumulative fields — upsertSnapshot copies pool.swapCount
  // into cumulativeSwapCount *before* this backfill runs, so those fields
  // reflect the inflated value and must be decremented here too.
  const hourTs = hourBucket(blockTimestamp);
  const snapId = snapshotId(poolId, hourTs);
  const snapshot = await context.PoolSnapshot.get(snapId);
  if (snapshot) {
    context.PoolSnapshot.set({
      ...snapshot,
      swapCount: Math.max(0, snapshot.swapCount - 1),
      swapVolume0:
        snapshot.swapVolume0 > lpVol0 ? snapshot.swapVolume0 - lpVol0 : 0n,
      swapVolume1:
        snapshot.swapVolume1 > lpVol1 ? snapshot.swapVolume1 - lpVol1 : 0n,
      cumulativeSwapCount: Math.max(0, snapshot.cumulativeSwapCount - 1),
      cumulativeVolume0:
        snapshot.cumulativeVolume0 > lpVol0
          ? snapshot.cumulativeVolume0 - lpVol0
          : 0n,
      cumulativeVolume1:
        snapshot.cumulativeVolume1 > lpVol1
          ? snapshot.cumulativeVolume1 - lpVol1
          : 0n,
    });
  }
}

// ---------------------------------------------------------------------------
// FPMMFactory
// ---------------------------------------------------------------------------

// Dynamically register pool tokens for ERC20FeeToken Transfer indexing.
// Only FPMM pools generate protocol fees (VirtualPools have no fee mechanism).
// Envio deduplicates addresses, so re-registering the same token is harmless.
FPMMFactory.FPMMDeployed.contractRegister(({ event, context }) => {
  context.addERC20FeeToken(event.params.token0);
  context.addERC20FeeToken(event.params.token1);
});

FPMMFactory.FPMMDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.fpmmProxy);
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fetch oracle state from chain at pool creation
  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};

  const [rateFeedID, rebalanceThreshold, dec0Raw, dec1Raw, invertRateFeed] =
    await Promise.all([
      fetchReferenceRateFeedID(event.chainId, poolId),
      // Use standalone getters — they work even when the oracle is stale,
      // unlike getRebalancingState() which reverts on stale/expired oracle data.
      fetchRebalanceThreshold(event.chainId, poolId),
      // Fetch token decimals scaling factors (e.g. 1e18 for 18-decimal tokens)
      fetchTokenDecimalsScaling(event.chainId, poolId, "decimals0", token0),
      fetchTokenDecimalsScaling(event.chainId, poolId, "decimals1", token1),
      fetchInvertRateFeed(event.chainId, poolId),
    ]);
  // Convert scaling factor (1e18, 1e6, etc.) to decimals count (18, 6, etc.)
  const token0Decimals = dec0Raw
    ? (scalingFactorToDecimals(dec0Raw) ?? 18)
    : 18;
  const token1Decimals = dec1Raw
    ? (scalingFactorToDecimals(dec1Raw) ?? 18)
    : 18;

  if (rateFeedID) {
    oracleDelta.referenceRateFeedID = rateFeedID;
    // Seed oracleExpiry and oracleNumReporters at pool creation so oracle
    // handlers can read them from the DB without per-event RPC calls.
    const [oracleExpiry, numReporters] = await Promise.all([
      fetchReportExpiry(event.chainId, rateFeedID, blockNumber),
      fetchNumReporters(event.chainId, rateFeedID, blockNumber),
    ]);
    if (oracleExpiry !== null) {
      oracleDelta.oracleExpiry = oracleExpiry;
    }
    if (numReporters !== null) {
      oracleDelta.oracleNumReporters = numReporters;
    }
  }

  oracleDelta.invertRateFeed = invertRateFeed;

  if (rebalanceThreshold > 0) {
    oracleDelta.rebalanceThreshold = rebalanceThreshold;
  }

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    token0,
    token1,
    source: "fpmm_factory",
    blockNumber,
    blockTimestamp,
    oracleDelta,
    tokenDecimals: { token0Decimals, token1Decimals },
  });

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

// ---------------------------------------------------------------------------
// FPMM.Swap
// ---------------------------------------------------------------------------

FPMM.Swap.handler(async ({ event, context }) => {
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

  // No fetchReserves RPC call needed: the FPMM contract calls _update()
  // before emitting Swap, so an UpdateReserves event with the exact post-swap
  // reserves always precedes this Swap event in the same tx. By the time this
  // handler runs, the UpdateReserves handler has already written reserves to
  // the Pool entity.
  const pool = await upsertPool({
    context,
    chainId: event.chainId,
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

  // Update trading limits for FPMM pools (guard: getTradingLimits reverts on VirtualPools)
  if (
    pool.source &&
    pool.source.includes("fpmm") &&
    pool.token0 &&
    pool.token1
  ) {
    const [limits0, limits1] = await Promise.all([
      fetchTradingLimits(event.chainId, event.srcAddress, pool.token0),
      fetchTradingLimits(event.chainId, event.srcAddress, pool.token1),
    ]);

    let worstP0 = 0;
    let worstP1 = 0;

    if (limits0) {
      const { p0, p1 } = computeLimitPressures(
        limits0.state.netflow0,
        limits0.state.netflow1,
        limits0.config.limit0,
        limits0.config.limit1,
      );
      worstP0 = Math.max(worstP0, p0, p1);
      const tl: TradingLimit = {
        id: `${poolId}-${pool.token0}`,
        poolId,
        token: pool.token0,
        limit0: limits0.config.limit0,
        limit1: limits0.config.limit1,
        decimals: TRADING_LIMITS_INTERNAL_DECIMALS,
        netflow0: limits0.state.netflow0,
        netflow1: limits0.state.netflow1,
        lastUpdated0: BigInt(limits0.state.lastUpdated0),
        lastUpdated1: BigInt(limits0.state.lastUpdated1),
        limitPressure0: p0.toFixed(4),
        limitPressure1: p1.toFixed(4),
        limitStatus: computeLimitStatus(p0, p1),
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      context.TradingLimit.set(tl);
    }

    if (limits1) {
      const { p0, p1 } = computeLimitPressures(
        limits1.state.netflow0,
        limits1.state.netflow1,
        limits1.config.limit0,
        limits1.config.limit1,
      );
      worstP1 = Math.max(worstP1, p0, p1);
      const tl: TradingLimit = {
        id: `${poolId}-${pool.token1}`,
        poolId,
        token: pool.token1,
        limit0: limits1.config.limit0,
        limit1: limits1.config.limit1,
        decimals: TRADING_LIMITS_INTERNAL_DECIMALS,
        netflow0: limits1.state.netflow0,
        netflow1: limits1.state.netflow1,
        lastUpdated0: BigInt(limits1.state.lastUpdated0),
        lastUpdated1: BigInt(limits1.state.lastUpdated1),
        limitPressure0: p0.toFixed(4),
        limitPressure1: p1.toFixed(4),
        limitStatus: computeLimitStatus(p0, p1),
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      };
      context.TradingLimit.set(tl);
    }

    if (limits0 || limits1) {
      const overallWorst = Math.max(worstP0, worstP1);
      const limitStatus = computeLimitStatus(overallWorst, 0);
      const updatedPool = await context.Pool.get(poolId);
      if (updatedPool) {
        context.Pool.set({
          ...updatedPool,
          limitStatus,
          limitPressure0: worstP0.toFixed(4),
          limitPressure1: worstP1.toFixed(4),
        });
      }
    }
  }

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
    // Assume user trade by default; Mint/Burn handlers will backfill to true
    // if a Mint or Burn event fires in the same transaction (LP rebalance swap).
    isLpSwap: false,
  };

  context.SwapEvent.set(swap);

  // Store a txHash-keyed lookup so the Mint/Burn handler (which fires later
  // in the same tx) can find this swap by chainId:poolId:txHash.
  const swapTxIndex: SwapTxIndex = {
    id: `${event.chainId}:${poolId}:${event.transaction.hash}`,
    swapEventId: id,
  };
  context.SwapTxIndex.set(swapTxIndex);
});

// ---------------------------------------------------------------------------
// FPMM.Mint
// ---------------------------------------------------------------------------

FPMM.Mint.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
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

  // If a Swap event fired earlier in this same transaction it was an internal
  // LP-rebalance swap, not a user trade. Backfill isLpSwap = true and subtract
  // its volume from the pool / snapshot cumulative trade counters.
  await backfillLpSwap({
    context,
    chainId: event.chainId,
    poolId,
    txHash: event.transaction.hash,
    blockTimestamp,
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

// ---------------------------------------------------------------------------
// FPMM.Burn
// ---------------------------------------------------------------------------

FPMM.Burn.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
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

  // Same as Mint: if a Swap event fired in this tx, it was LP-triggered.
  await backfillLpSwap({
    context,
    chainId: event.chainId,
    poolId,
    txHash: event.transaction.hash,
    blockTimestamp,
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

// ---------------------------------------------------------------------------
// FPMM.UpdateReserves
// ---------------------------------------------------------------------------

FPMM.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const rebalancingState = await fetchRebalancingState(
    event.chainId,
    poolId,
    blockNumber,
  );

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};
  if (rebalancingState) {
    const existing = await context.Pool.get(poolId);
    const isInverted = existing?.invertRateFeed ?? false;
    const oraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      oraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      priceDifference: rebalancingState.priceDifference,
      oracleTimestamp: blockTimestamp,
    };
  }

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
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

  if (rebalancingState) {
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: oracleDelta.oraclePrice!,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "update_reserves",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }

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

// ---------------------------------------------------------------------------
// FPMM.Rebalanced
// ---------------------------------------------------------------------------

FPMM.Rebalanced.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const rebalancingState = await fetchRebalancingState(
    event.chainId,
    poolId,
    blockNumber,
  );

  const rebalancerAddress = asAddress(event.params.sender);

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {
    lastRebalancedAt: blockTimestamp,
    rebalancerAddress,
    rebalanceLivenessStatus: "ACTIVE",
    priceDifference: event.params.priceDifferenceAfter,
  };

  if (rebalancingState) {
    const existing = await context.Pool.get(poolId);
    const isInverted = existing?.invertRateFeed ?? false;
    const oraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      ...oracleDelta,
      oraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      oracleTimestamp: blockTimestamp,
    };
  }

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    rebalanceDelta: true,
    oracleDelta,
  });

  if (rebalancingState) {
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: oracleDelta.oraclePrice!,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "rebalanced",
      blockNumber,
    };
    context.OracleSnapshot.set(snapshot);
  }

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    rebalanceDelta: true,
  });

  const priceDifferenceBefore = event.params.priceDifferenceBefore;
  const priceDifferenceAfter = event.params.priceDifferenceAfter;
  const improvement = priceDifferenceBefore - priceDifferenceAfter;
  const effectivenessRatio =
    priceDifferenceBefore > 0n
      ? (Number(improvement) / Number(priceDifferenceBefore)).toFixed(4)
      : "0.0000";

  const rebalanced: RebalanceEvent = {
    id,
    poolId,
    sender: rebalancerAddress,
    caller: event.transaction.from ?? "",
    priceDifferenceBefore,
    priceDifferenceAfter,
    improvement,
    effectivenessRatio,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});

// ---------------------------------------------------------------------------
// FPMM.TradingLimitConfigured
// ---------------------------------------------------------------------------

FPMM.TradingLimitConfigured.handler(async ({ event, context }) => {
  const poolId = asAddress(event.srcAddress);
  const token = asAddress(event.params.token);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const configTuple = event.params.config as unknown as [
    bigint,
    bigint,
    number,
  ];
  const eventLimit0 = configTuple[0];
  const eventLimit1 = configTuple[1];

  const limits = await fetchTradingLimits(
    event.chainId,
    event.srcAddress,
    event.params.token,
  );

  const limit0 = limits ? limits.config.limit0 : eventLimit0;
  const limit1 = limits ? limits.config.limit1 : eventLimit1;
  const decimals = TRADING_LIMITS_INTERNAL_DECIMALS;
  const netflow0 = limits ? limits.state.netflow0 : 0n;
  const netflow1 = limits ? limits.state.netflow1 : 0n;
  const lastUpdated0 = limits ? BigInt(limits.state.lastUpdated0) : 0n;
  const lastUpdated1 = limits ? BigInt(limits.state.lastUpdated1) : 0n;

  const { p0, p1 } = computeLimitPressures(netflow0, netflow1, limit0, limit1);
  const limitStatus = computeLimitStatus(p0, p1);

  const tl: TradingLimit = {
    id: `${poolId}-${token}`,
    poolId,
    token,
    limit0,
    limit1,
    decimals,
    netflow0,
    netflow1,
    lastUpdated0,
    lastUpdated1,
    limitPressure0: p0.toFixed(4),
    limitPressure1: p1.toFixed(4),
    limitStatus,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  context.TradingLimit.set(tl);

  const pool = await context.Pool.get(poolId);
  if (pool) {
    context.Pool.set({
      ...pool,
      limitStatus,
      limitPressure0: p0.toFixed(4),
      limitPressure1: p1.toFixed(4),
    });
  }
});

// ---------------------------------------------------------------------------
// FPMM.LiquidityStrategyUpdated
// ---------------------------------------------------------------------------

FPMM.LiquidityStrategyUpdated.handler(async ({ event, context }) => {
  const poolId = asAddress(event.srcAddress);
  const strategy = asAddress(event.params.strategy);
  const status = event.params.status;

  const pool = await context.Pool.get(poolId);
  if (!pool) return;

  if (status) {
    context.Pool.set({ ...pool, rebalancerAddress: strategy });
  } else if (pool.rebalancerAddress === strategy) {
    context.Pool.set({ ...pool, rebalancerAddress: "" });
  }
});
