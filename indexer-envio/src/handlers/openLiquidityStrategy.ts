// ---------------------------------------------------------------------------
// OpenLiquidityStrategy event handlers
// ---------------------------------------------------------------------------

import {
  OpenLiquidityStrategy,
  type OlsPool,
  type OlsLiquidityEvent,
  type OlsLifecycleEvent,
} from "generated";
import { eventId, asAddress, asBigInt } from "../helpers";

// ---------------------------------------------------------------------------
// PoolAdded
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.PoolAdded.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const p = event.params.params;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // params tuple: [pool, debtToken, cooldown, protocolFeeRecipient,
  //                liquiditySourceIncentiveExpansion, protocolIncentiveExpansion,
  //                liquiditySourceIncentiveContraction, protocolIncentiveContraction]
  const olsPool: OlsPool = {
    id: poolId,
    olsAddress: asAddress(event.srcAddress),
    isActive: true,
    debtToken: asAddress(p[1]),
    rebalanceCooldown: p[2], // already bigint
    lastRebalance: 0n,
    protocolFeeRecipient: asAddress(p[3]),
    liquiditySourceIncentiveExpansion: p[4],
    liquiditySourceIncentiveContraction: p[6],
    protocolIncentiveExpansion: p[5],
    protocolIncentiveContraction: p[7],
    olsRebalanceCount: 0,
    addedAtBlock: blockNumber,
    addedAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };

  context.OlsPool.set(olsPool);

  const lifecycle: OlsLifecycleEvent = {
    id,
    poolId,
    olsAddress: asAddress(event.srcAddress),
    action: "POOL_ADDED",
    cooldown: 0n,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.OlsLifecycleEvent.set(lifecycle);
});

// ---------------------------------------------------------------------------
// PoolRemoved
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.PoolRemoved.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const existing = await context.OlsPool.get(poolId);
  if (existing) {
    context.OlsPool.set({
      ...existing,
      isActive: false,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });
  }

  const lifecycle: OlsLifecycleEvent = {
    id,
    poolId,
    olsAddress: asAddress(event.srcAddress),
    action: "POOL_REMOVED",
    cooldown: 0n,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.OlsLifecycleEvent.set(lifecycle);
});

// ---------------------------------------------------------------------------
// RebalanceCooldownSet
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.RebalanceCooldownSet.handler(
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = asAddress(event.params.pool);
    const cooldown = event.params.cooldown; // already bigint
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const existing = await context.OlsPool.get(poolId);
    if (existing) {
      context.OlsPool.set({
        ...existing,
        rebalanceCooldown: cooldown,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
    }

    const lifecycle: OlsLifecycleEvent = {
      id,
      poolId,
      olsAddress: asAddress(event.srcAddress),
      action: "COOLDOWN_SET",
      cooldown,
      txHash: event.transaction.hash,
      blockNumber,
      blockTimestamp,
    };

    context.OlsLifecycleEvent.set(lifecycle);
  },
);

// ---------------------------------------------------------------------------
// LiquidityMoved
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.LiquidityMoved.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Update lastRebalance + counter on OlsPool
  const existing = await context.OlsPool.get(poolId);
  if (existing) {
    context.OlsPool.set({
      ...existing,
      lastRebalance: blockTimestamp,
      olsRebalanceCount: existing.olsRebalanceCount + 1,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });
  }

  const olsEvent: OlsLiquidityEvent = {
    id,
    poolId,
    olsAddress: asAddress(event.srcAddress),
    direction: Number(event.params.direction), // 0=Expand, 1=Contract
    tokenGivenToPool: asAddress(event.params.tokenGivenToPool),
    amountGivenToPool: event.params.amountGivenToPool,
    tokenTakenFromPool: asAddress(event.params.tokenTakenFromPool),
    amountTakenFromPool: event.params.amountTakenFromPool,
    caller: event.transaction.from ?? "",
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.OlsLiquidityEvent.set(olsEvent);
});
