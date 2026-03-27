// ---------------------------------------------------------------------------
// OpenLiquidityStrategy event handlers
// ---------------------------------------------------------------------------

import {
  OpenLiquidityStrategy,
  type OlsPool,
  type OlsLiquidityEvent,
  type OlsLifecycleEvent,
} from "generated";
import { eventId, asAddress, asBigInt, makePoolId } from "../helpers";

/**
 * OLS pool record ID: "{chainId}-{poolAddress}-{olsAddress}".
 * One record per (pool, OLS contract) — re-registration creates a fresh record
 * instead of silently overwriting history.
 */
function makeOlsPoolId(poolId: string, olsAddress: string): string {
  return `${poolId}-${olsAddress}`;
}

function placeholderOlsPool(args: {
  id: string;
  chainId: number;
  poolId: string;
  olsAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): OlsPool {
  return {
    id: args.id,
    chainId: args.chainId,
    poolId: args.poolId,
    olsAddress: args.olsAddress,
    isActive: true,
    debtToken: "",
    rebalanceCooldown: 0n,
    lastRebalance: 0n,
    protocolFeeRecipient: "",
    liquiditySourceIncentiveExpansion: 0n,
    liquiditySourceIncentiveContraction: 0n,
    protocolIncentiveExpansion: 0n,
    protocolIncentiveContraction: 0n,
    olsRebalanceCount: 0,
    addedAtBlock: args.blockNumber,
    addedAtTimestamp: args.blockTimestamp,
    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.blockTimestamp,
  };
}

async function getOrCreateOlsPool(args: {
  context: { OlsPool: { get: (id: string) => Promise<OlsPool | undefined> } };
  chainId: number;
  poolId: string;
  olsAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Promise<OlsPool> {
  const id = makeOlsPoolId(args.poolId, args.olsAddress);
  const existing = await args.context.OlsPool.get(id);
  return (
    existing ??
    placeholderOlsPool({
      id,
      chainId: args.chainId,
      poolId: args.poolId,
      olsAddress: args.olsAddress,
      blockNumber: args.blockNumber,
      blockTimestamp: args.blockTimestamp,
    })
  );
}

// ---------------------------------------------------------------------------
// PoolAdded
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.PoolAdded.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.params.pool);
  const olsAddress = asAddress(event.srcAddress);
  const p = event.params.params;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // params tuple: [pool, debtToken, cooldown, protocolFeeRecipient,
  //                liquiditySourceIncentiveExpansion, protocolIncentiveExpansion,
  //                liquiditySourceIncentiveContraction, protocolIncentiveContraction]
  const olsPool: OlsPool = {
    id: makeOlsPoolId(poolId, olsAddress),
    chainId: event.chainId,
    poolId,
    olsAddress,
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
    chainId: event.chainId,
    poolId,
    olsAddress,
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
  const poolId = makePoolId(event.chainId, event.params.pool);
  const olsAddress = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const existing = await getOrCreateOlsPool({
    context,
    chainId: event.chainId,
    poolId,
    olsAddress,
    blockNumber,
    blockTimestamp,
  });
  context.OlsPool.set({
    ...existing,
    isActive: false,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });

  const lifecycle: OlsLifecycleEvent = {
    id,
    chainId: event.chainId,
    poolId,
    olsAddress,
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
    const poolId = makePoolId(event.chainId, event.params.pool);
    const olsAddress = asAddress(event.srcAddress);
    const cooldown = event.params.cooldown; // already bigint
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const existing = await getOrCreateOlsPool({
      context,
      chainId: event.chainId,
      poolId,
      olsAddress,
      blockNumber,
      blockTimestamp,
    });
    context.OlsPool.set({
      ...existing,
      rebalanceCooldown: cooldown,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });

    const lifecycle: OlsLifecycleEvent = {
      id,
      chainId: event.chainId,
      poolId,
      olsAddress,
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
  const poolId = makePoolId(event.chainId, event.params.pool);
  const olsAddress = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Update lastRebalance + counter on OlsPool, even if indexing started
  // after the historical PoolAdded event.
  const existing = await getOrCreateOlsPool({
    context,
    chainId: event.chainId,
    poolId,
    olsAddress,
    blockNumber,
    blockTimestamp,
  });
  context.OlsPool.set({
    ...existing,
    lastRebalance: blockTimestamp,
    olsRebalanceCount: existing.olsRebalanceCount + 1,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });

  const olsEvent: OlsLiquidityEvent = {
    id,
    chainId: event.chainId,
    poolId,
    olsAddress,
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
