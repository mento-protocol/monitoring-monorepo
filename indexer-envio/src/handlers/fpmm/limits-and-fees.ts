// ---------------------------------------------------------------------------
// FPMM limits and fees handlers: TradingLimitConfigured + LiquidityStrategyUpdated
// + LPFeeUpdated + ProtocolFeeUpdated + RebalanceIncentiveUpdated
// ---------------------------------------------------------------------------

import { indexer, type Pool, type TradingLimit } from "envio";
import { asAddress, asBigInt, makePoolId } from "../../helpers.js";
import {
  TRADING_LIMITS_INTERNAL_DECIMALS,
  computeLimitPressures,
  computeLimitStatus,
} from "../../tradingLimits.js";
import { tradingLimitsEffect } from "../../rpc/effects.js";
import { maybePreloadPool } from "../../pool.js";

// ---------------------------------------------------------------------------
// FPMM.TradingLimitConfigured
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "TradingLimitConfigured" },
  async ({ event, context }) => {
    const poolId = makePoolId(event.chainId, event.srcAddress);
    // See state-sync.ts → UpdateReserves handler. `fetchTradingLimits` is a raw
    // RPC call that must not run in preload for the same in-batch-state reasons.
    if (await maybePreloadPool(context, poolId)) return;
    const token = asAddress(event.params.token);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const eventLimit0 = event.params.config.limit0;
    const eventLimit1 = event.params.config.limit1;

    const limits = await context.effect(tradingLimitsEffect, {
      chainId: event.chainId,
      poolAddress: event.srcAddress,
      token: event.params.token,
      blockNumber,
    });

    const limit0 = limits ? limits.config.limit0 : eventLimit0;
    const limit1 = limits ? limits.config.limit1 : eventLimit1;
    const decimals = TRADING_LIMITS_INTERNAL_DECIMALS;
    const netflow0 = limits ? limits.state.netflow0 : 0n;
    const netflow1 = limits ? limits.state.netflow1 : 0n;
    const lastUpdated0 = limits ? BigInt(limits.state.lastUpdated0) : 0n;
    const lastUpdated1 = limits ? BigInt(limits.state.lastUpdated1) : 0n;

    const { p0, p1 } = computeLimitPressures(
      netflow0,
      netflow1,
      limit0,
      limit1,
    );
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
  },
);

// ---------------------------------------------------------------------------
// FPMM.LiquidityStrategyUpdated
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "LiquidityStrategyUpdated" },
  async ({ event, context }) => {
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
  },
);

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

indexer.onEvent(
  { contract: "FPMM", event: "LPFeeUpdated" },
  async ({ event, context }) =>
    updatePoolFeeField(context, event, "lpFee", event.params.newFee),
);

indexer.onEvent(
  { contract: "FPMM", event: "ProtocolFeeUpdated" },
  async ({ event, context }) =>
    updatePoolFeeField(context, event, "protocolFee", event.params.newFee),
);

indexer.onEvent(
  { contract: "FPMM", event: "RebalanceIncentiveUpdated" },
  async ({ event, context }) =>
    updatePoolFeeField(
      context,
      event,
      "rebalanceReward",
      event.params.newIncentive,
    ),
);
