// ---------------------------------------------------------------------------
// VirtualPoolFactory and VirtualPool event handlers
// ---------------------------------------------------------------------------

import {
  VirtualPoolFactory,
  VirtualPool,
  type SwapEvent,
  type LiquidityEvent,
  type ReserveUpdate,
  type RebalanceEvent,
  type VirtualPoolLifecycle,
} from "generated";
import { eventId, asAddress, asBigInt, makePoolId } from "../helpers";
import { upsertPool, upsertSnapshot, DEFAULT_ORACLE_FIELDS } from "../pool";
import { computeEffectivenessRatio } from "../priceDifference";

// ---------------------------------------------------------------------------
// VirtualPoolFactory.VirtualPoolDeployed
// ---------------------------------------------------------------------------

// Dynamically register the deployed VirtualPool so Envio indexes its events
// (Swap, Mint, Burn, etc.) without a hardcoded address list in the config.
// Note: contractRegister is not exercised by the Envio test harness — see
// fpmm.ts for the same pattern and the explanation of why it's untestable.
VirtualPoolFactory.VirtualPoolDeployed.contractRegister(
  ({ event, context }) => {
    context.addVirtualPool(event.params.pool);
  },
);

VirtualPoolFactory.VirtualPoolDeployed.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.params.pool);
  const token0 = asAddress(event.params.token0);
  const token1 = asAddress(event.params.token1);

  await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    token0,
    token1,
    source: "virtual_pool_factory",
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    oracleDelta: {
      ...DEFAULT_ORACLE_FIELDS,
      healthStatus: "N/A",
    },
  });

  const lifecycle: VirtualPoolLifecycle = {
    id,
    chainId: event.chainId,
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

// ---------------------------------------------------------------------------
// VirtualPoolFactory.PoolDeprecated
// ---------------------------------------------------------------------------

VirtualPoolFactory.PoolDeprecated.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.params.pool);

  await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "virtual_pool_factory",
    blockNumber: asBigInt(event.block.number),
    blockTimestamp: asBigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });

  const lifecycle: VirtualPoolLifecycle = {
    id,
    chainId: event.chainId,
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
// VirtualPool.Swap
// ---------------------------------------------------------------------------

VirtualPool.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
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

  // No fetchReserves RPC call needed: the contract calls _update() before
  // emitting Swap, so UpdateReserves always precedes this event in the same tx.
  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_swap", // reuse source key; VirtualPool inherits same priority
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
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
    chainId: event.chainId,
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

// ---------------------------------------------------------------------------
// VirtualPool.Mint
// ---------------------------------------------------------------------------

VirtualPool.Mint.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_mint",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
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
    chainId: event.chainId,
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
// VirtualPool.Burn
// ---------------------------------------------------------------------------

VirtualPool.Burn.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_burn",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
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
    chainId: event.chainId,
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
// VirtualPool.UpdateReserves
// ---------------------------------------------------------------------------

VirtualPool.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_update_reserves",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
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
    chainId: event.chainId,
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
// VirtualPool.Rebalanced
// ---------------------------------------------------------------------------

VirtualPool.Rebalanced.handler(async ({ event, context }) => {
  // VirtualPools rarely emit Rebalanced — handler is intentionally minimal
  // (no oracle/RPC fetch) compared to the FPMM version, since VirtualPools
  // manage reserves differently. If the contract emits this event, it's real.
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Compute effectiveness ratio up-front. Helper returns `null` for degenerate
  // rebalances (`before == 0`); Pool row uses `-1` sentinel (gauge-skip path),
  // RebalanceEvent uses `0.0000` for dashboard back-compat.
  const priceDifferenceBefore = event.params.priceDifferenceBefore;
  const priceDifferenceAfter = event.params.priceDifferenceAfter;
  const improvement = priceDifferenceBefore - priceDifferenceAfter;
  const rawEffectivenessRatio = computeEffectivenessRatio(
    priceDifferenceBefore,
    priceDifferenceAfter,
  );
  const lastEffectivenessRatio = rawEffectivenessRatio ?? "-1";
  const eventEffectivenessRatio = rawEffectivenessRatio ?? "0.0000";

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    rebalanceDelta: true,
    // Match FPMM.Rebalanced symmetry: persist both the event-time rebalance
    // anchor and the effectiveness ratio. `lastRebalancedAt` is inert today
    // (metrics-bridge filters pools to `source LIKE '%fpmm%'` and VirtualPools
    // resolve to `virtual_pool_factory` source), but setting it keeps the
    // Pool row internally consistent — future code that surfaces VirtualPool
    // rebalance metrics won't hit `lastRebalancedAt = 0` and fail the PromQL
    // recency gate.
    oracleDelta: { lastRebalancedAt: blockTimestamp, lastEffectivenessRatio },
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
    chainId: event.chainId,
    poolId,
    sender: asAddress(event.params.sender),
    caller: event.transaction.from ?? "",
    priceDifferenceBefore,
    priceDifferenceAfter,
    improvement,
    effectivenessRatio: eventEffectivenessRatio,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});
