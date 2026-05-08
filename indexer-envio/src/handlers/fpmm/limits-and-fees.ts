// ---------------------------------------------------------------------------
// FPMM limits and fees handlers: TradingLimitConfigured + LiquidityStrategyUpdated
// + LPFeeUpdated + ProtocolFeeUpdated + RebalanceIncentiveUpdated
// + RebalanceThresholdUpdated
// ---------------------------------------------------------------------------

import { FPMM, type Pool, type TradingLimit } from "generated";
import { asAddress, asBigInt, makePoolId } from "../../helpers";
import {
  TRADING_LIMITS_INTERNAL_DECIMALS,
  computeLimitPressures,
  computeLimitStatus,
} from "../../tradingLimits";
import { tradingLimitsEffect } from "../../rpc/effects";
import {
  computeHealthStatus,
  maybePreloadPool,
  nextDeviationBreachStartedAt,
} from "../../pool";
import { pickActiveThreshold } from "../../priceDifference";
import { recordBreachTransition } from "../../deviationBreach";
import { recordHealthSample } from "../../healthScore";

// ---------------------------------------------------------------------------
// FPMM.TradingLimitConfigured
// ---------------------------------------------------------------------------

FPMM.TradingLimitConfigured.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // See state-sync.ts → UpdateReserves handler. `fetchTradingLimits` is a raw
  // RPC call that must not run in preload for the same in-batch-state reasons.
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

// ---------------------------------------------------------------------------
// FPMM.RebalanceThresholdUpdated
// ---------------------------------------------------------------------------

// A governance threshold change can by itself open or close a breach
// (e.g. tightening from 300 to 100 makes a previously-healthy pool
// breached). Routing through the same breach/health pipeline that
// MedianUpdated/OracleReported use (compute new active threshold from
// `lastMedianPrice` direction, recompute breach anchor + health,
// `recordBreachTransition`, `recordHealthSample`) ensures the
// dependent state lands in the same event rather than waiting for the
// next reserve/oracle event. Falls back to `above` for degenerate pools
// (zero reserves / no median yet); the next state-sync event re-picks
// once those land.
FPMM.RebalanceThresholdUpdated.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  const existing = await context.Pool.get(poolId);
  if (!existing) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  const above = Number(event.params.newThresholdAbove);
  const below = Number(event.params.newThresholdBelow);
  // Direction is determined by reservePrice vs. on-chain median; pass a
  // synthetic pool view that uses `lastMedianPrice` as the oracle source
  // so reporter-quote contamination of `oraclePrice` doesn't flip direction.
  const active = pickActiveThreshold(
    {
      reserves0: existing.reserves0,
      reserves1: existing.reserves1,
      oraclePrice: existing.lastMedianPrice,
      invertRateFeed: existing.invertRateFeed,
      token0Decimals: existing.token0Decimals,
      token1Decimals: existing.token1Decimals,
    },
    { above, below },
  );
  const updatedPool: Pool = {
    ...existing,
    rebalanceThresholdAbove: above,
    rebalanceThresholdBelow: below,
    rebalanceThreshold: active,
    rebalanceThresholdsKnown: true,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
  // priceDifference is reserves+oracle-derived, not threshold-derived, so
  // we don't recompute it here — but breach/health predicates ARE
  // threshold-derived, so they must run with the new active value.
  const deviationBreachStartedAt = nextDeviationBreachStartedAt(
    existing,
    updatedPool,
    blockTimestamp,
  );
  const withBreach: Pool = { ...updatedPool, deviationBreachStartedAt };
  const healthStatus = computeHealthStatus(withBreach, blockTimestamp);
  const finalPool: Pool = { ...withBreach, healthStatus };

  const breachPoolUpdate = await recordBreachTransition(
    context,
    existing,
    finalPool,
    {
      blockTimestamp,
      blockNumber,
      txHash: event.transaction.hash,
      source: "fpmm_threshold_updated",
    },
  );
  const { poolUpdate } = recordHealthSample(
    finalPool,
    finalPool.priceDifference,
    active,
    blockTimestamp,
  );
  context.Pool.set({
    ...finalPool,
    ...poolUpdate,
    ...breachPoolUpdate,
  });
});
