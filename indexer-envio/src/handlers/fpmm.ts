// ---------------------------------------------------------------------------
// FPMM event handlers
// ---------------------------------------------------------------------------

import { FPMM, type Pool, type SwapEvent, type TradingLimit } from "generated";
import { eventId, asAddress, asBigInt, makePoolId } from "../helpers";
import {
  TRADING_LIMITS_INTERNAL_DECIMALS,
  computeLimitPressures,
  computeLimitStatus,
} from "../tradingLimits";
import { fetchTradingLimits } from "../rpc";
import { maybePreloadPool, upsertPool, upsertSnapshot } from "../pool";

// ---------------------------------------------------------------------------
// FPMM.Swap
// ---------------------------------------------------------------------------

FPMM.Swap.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  if (await maybePreloadPool(context, poolId)) return;
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

  // Update trading limits for FPMM pools (guard: getTradingLimits reverts on VirtualPools)
  if (
    pool.source &&
    pool.source.includes("fpmm") &&
    pool.token0 &&
    pool.token1
  ) {
    const [limits0, limits1] = await Promise.all([
      fetchTradingLimits(
        event.chainId,
        event.srcAddress,
        pool.token0,
        blockNumber,
      ),
      fetchTradingLimits(
        event.chainId,
        event.srcAddress,
        pool.token1,
        blockNumber,
      ),
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
        chainId: event.chainId,
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
        chainId: event.chainId,
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
      // Log when only one token's limits were fetched — partial state is usable
      // but indicates an RPC hiccup that will be retried on the next Swap.
      if (!limits0 || !limits1) {
        console.warn(
          `[FPMM.Swap] Partial trading limit fetch for pool ${poolId}: ` +
            `limits0=${!!limits0} limits1=${!!limits1}. ` +
            `limitStatus will reflect the available data only.`,
        );
      }
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
// FPMM.TradingLimitConfigured
// ---------------------------------------------------------------------------

FPMM.TradingLimitConfigured.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // See UpdateReserves handler. `fetchTradingLimits` is a raw RPC call
  // that must not run in preload for the same in-batch-state reasons.
  if (await maybePreloadPool(context, poolId)) return;
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
    blockNumber,
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
    chainId: event.chainId,
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
  const poolId = makePoolId(event.chainId, event.srcAddress);
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

// ---------------------------------------------------------------------------
// Fee / incentive updates — three handlers share the same read-modify-write
// shape against a single Pool field, so the body lives in this helper and
// each handler is a one-liner that picks the target field + param name.
// ---------------------------------------------------------------------------

type FeeFieldKey = "lpFee" | "protocolFee" | "rebalanceReward";

async function updatePoolFeeField(
  context: {
    Pool: {
      get: (id: string) => Promise<Pool | undefined>;
      set: (entity: Pool) => void;
    };
  },
  event: {
    chainId: number;
    srcAddress: string;
    block: { number: number; timestamp: number };
  },
  field: FeeFieldKey,
  newValue: bigint,
): Promise<void> {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const pool = await context.Pool.get(poolId);
  if (!pool) return;
  context.Pool.set({
    ...pool,
    [field]: Number(newValue),
    updatedAtBlock: asBigInt(event.block.number),
    updatedAtTimestamp: asBigInt(event.block.timestamp),
  });
}

FPMM.LPFeeUpdated.handler(async ({ event, context }) =>
  updatePoolFeeField(context, event, "lpFee", event.params.newFee),
);

FPMM.ProtocolFeeUpdated.handler(async ({ event, context }) =>
  updatePoolFeeField(context, event, "protocolFee", event.params.newFee),
);

FPMM.RebalanceIncentiveUpdated.handler(async ({ event, context }) =>
  updatePoolFeeField(
    context,
    event,
    "rebalanceReward",
    event.params.newIncentive,
  ),
);
