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
import { buildSwapTraderFields } from "../swap";
import { applyLeaderboardSnapshots } from "../leaderboardSnapshots";
import { fetchTokenDecimalsScaling } from "../rpc";
import {
  buildRebalanceOutcome,
  scalingFactorToDecimals,
} from "../priceDifference";

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
  const poolAddr = asAddress(event.params.pool);

  // Fetch token decimals so `Pool.token{0,1}Decimals` are correct from the
  // start instead of inheriting the 18/18 default. Mirrors the FPMM factory
  // pattern (handlers/fpmm/factory.ts). Required for `volumeUsdWei` to scale
  // correctly when a USD-pegged non-18dp token (e.g. USDC, 6dp) is on a leg.
  const [dec0Raw, dec1Raw] = await Promise.all([
    fetchTokenDecimalsScaling(event.chainId, poolAddr, "decimals0", token0),
    fetchTokenDecimalsScaling(event.chainId, poolAddr, "decimals1", token1),
  ]);
  const token0Decimals = dec0Raw
    ? (scalingFactorToDecimals(dec0Raw) ?? 18)
    : 18;
  const token1Decimals = dec1Raw
    ? (scalingFactorToDecimals(dec1Raw) ?? 18)
    : 18;

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
    tokenDecimals: { token0Decimals, token1Decimals },
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

  const traderFields = buildSwapTraderFields(event, pool);
  const swap: SwapEvent = {
    id,
    chainId: event.chainId,
    poolId,
    sender: asAddress(event.params.sender),
    recipient: asAddress(event.params.to),
    ...traderFields,
    amount0In: event.params.amount0In,
    amount1In: event.params.amount1In,
    amount0Out: event.params.amount0Out,
    amount1Out: event.params.amount1Out,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.SwapEvent.set(swap);

  await applyLeaderboardSnapshots({
    context,
    chainId: event.chainId,
    poolId,
    pool,
    caller: traderFields.caller,
    txTo: traderFields.txTo,
    volumeUsdWei: traderFields.volumeUsdWei,
    amounts: {
      amount0In: event.params.amount0In,
      amount0Out: event.params.amount0Out,
      amount1In: event.params.amount1In,
      amount1Out: event.params.amount1Out,
    },
    blockNumber,
    blockTimestamp,
  });
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

  // VirtualPools don't make RPC reads here; threshold comes from the Pool
  // row. Most VirtualPools have threshold=0 (no oracle band), which collapses
  // effectiveness to null → skipped by metrics-bridge. The Pool fetch also
  // feeds upsertPool below.
  const existing = await context.Pool.get(poolId);
  const rebalanceThresholdForEvent = existing?.rebalanceThreshold ?? 0;
  const priceDifferenceBefore = event.params.priceDifferenceBefore;
  const priceDifferenceAfter = event.params.priceDifferenceAfter;
  const { improvement, lastEffectivenessRatio, eventEffectivenessRatio } =
    buildRebalanceOutcome({
      priceDifferenceBefore,
      priceDifferenceAfter,
      rebalanceThreshold: rebalanceThresholdForEvent,
    });

  const pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    rebalanceDelta: true,
    // `lastRebalancedAt` is inert today (metrics-bridge filters to fpmm
    // sources) but kept symmetric with FPMM.Rebalanced so future VirtualPool
    // metrics won't see a 0 anchor.
    oracleDelta: { lastRebalancedAt: blockTimestamp, lastEffectivenessRatio },
    existing: { pool: existing },
  });

  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    rebalanceDelta: true,
  });

  // VirtualPools don't fund rebalance incentives the way FPMMs do (no oracle
  // band → no protocol-paid caller reward), so the USD profit fields stay
  // empty here. metrics-bridge already filters VirtualPool rebalances out.
  const rebalanced: RebalanceEvent = {
    id,
    chainId: event.chainId,
    poolId,
    sender: asAddress(event.params.sender),
    caller: event.transaction.from ?? "",
    priceDifferenceBefore,
    priceDifferenceAfter,
    improvement,
    rebalanceThreshold: rebalanceThresholdForEvent,
    effectivenessRatio: eventEffectivenessRatio,
    amount0Delta: 0n,
    amount1Delta: 0n,
    rewardBps: 0,
    notionalUsd: "",
    rewardUsd: "",
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.RebalanceEvent.set(rebalanced);
});
