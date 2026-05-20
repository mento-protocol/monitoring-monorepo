// ---------------------------------------------------------------------------
// OpenLiquidityStrategy event handlers
// ---------------------------------------------------------------------------

import type {
  EvmOnEventContext,
  OlsLifecycleEvent,
  OlsLiquidityEvent,
  OlsPool,
} from "envio";
import { indexer } from "../indexer.js";
import { eventId, asAddress, asBigInt, makePoolId } from "../helpers.js";

/**
 * OLS pool record ID: "{chainId}-{poolAddress}-{olsAddress}-{registrationId}".
 * One record per PoolAdded registration — re-registration creates a fresh
 * record instead of silently overwriting history.
 */
function makeOlsPoolId(
  poolId: string,
  olsAddress: string,
  registrationId: string,
): string {
  return `${poolId}-${olsAddress}-${registrationId}`;
}

type OlsPoolContext = Pick<EvmOnEventContext, "OlsPool">;

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
  context: OlsPoolContext;
  chainId: number;
  poolId: string;
  olsAddress: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Promise<OlsPool> {
  const existing = await getLatestActiveOlsPool(args.context, {
    poolId: args.poolId,
    olsAddress: args.olsAddress,
  });
  const id = makeOlsPoolId(args.poolId, args.olsAddress, "backfill");
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

async function getActiveOlsPools(
  context: OlsPoolContext,
  args: { poolId: string; olsAddress: string },
): Promise<OlsPool[]> {
  const rows = await context.OlsPool.getWhere({
    poolId: { _eq: args.poolId },
  });
  return rows.filter(
    (row) => row.olsAddress === args.olsAddress && row.isActive,
  );
}

function latestOlsPool(rows: readonly OlsPool[]): OlsPool | undefined {
  return [...rows].sort((a, b) => {
    if (a.addedAtBlock !== b.addedAtBlock) {
      return a.addedAtBlock > b.addedAtBlock ? -1 : 1;
    }
    if (a.addedAtTimestamp !== b.addedAtTimestamp) {
      return a.addedAtTimestamp > b.addedAtTimestamp ? -1 : 1;
    }
    return b.id.localeCompare(a.id);
  })[0];
}

async function getLatestActiveOlsPool(
  context: OlsPoolContext,
  args: { poolId: string; olsAddress: string },
): Promise<OlsPool | undefined> {
  return latestOlsPool(await getActiveOlsPools(context, args));
}

// ---------------------------------------------------------------------------
// PoolAdded
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "OpenLiquidityStrategy", event: "PoolAdded" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.params.pool);
    const olsAddress = asAddress(event.srcAddress);
    const p = event.params.params;
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const activePools = await getActiveOlsPools(context, {
      poolId,
      olsAddress,
    });

    if (context.isPreload) return;

    for (const activePool of activePools) {
      context.OlsPool.set({
        ...activePool,
        isActive: false,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
    }

    const olsPool: OlsPool = {
      id: makeOlsPoolId(poolId, olsAddress, id),
      chainId: event.chainId,
      poolId,
      olsAddress,
      isActive: true,
      debtToken: asAddress(p.debtToken),
      rebalanceCooldown: p.cooldown,
      lastRebalance: 0n,
      protocolFeeRecipient: asAddress(p.protocolFeeRecipient),
      liquiditySourceIncentiveExpansion: p.liquiditySourceIncentiveExpansion,
      liquiditySourceIncentiveContraction:
        p.liquiditySourceIncentiveContraction,
      protocolIncentiveExpansion: p.protocolIncentiveExpansion,
      protocolIncentiveContraction: p.protocolIncentiveContraction,
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
  },
);

// ---------------------------------------------------------------------------
// PoolRemoved
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "OpenLiquidityStrategy", event: "PoolRemoved" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.params.pool);
    const olsAddress = asAddress(event.srcAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (context.isPreload) {
      await getLatestActiveOlsPool(context, { poolId, olsAddress });
      return;
    }

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
  },
);

// ---------------------------------------------------------------------------
// RebalanceCooldownSet
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "OpenLiquidityStrategy", event: "RebalanceCooldownSet" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.params.pool);
    const olsAddress = asAddress(event.srcAddress);
    const cooldown = event.params.cooldown; // already bigint
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (context.isPreload) {
      await getLatestActiveOlsPool(context, { poolId, olsAddress });
      return;
    }

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

indexer.onEvent(
  { contract: "OpenLiquidityStrategy", event: "LiquidityMoved" },
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.params.pool);
    const olsAddress = asAddress(event.srcAddress);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    if (context.isPreload) {
      await getLatestActiveOlsPool(context, { poolId, olsAddress });
      return;
    }

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
  },
);
