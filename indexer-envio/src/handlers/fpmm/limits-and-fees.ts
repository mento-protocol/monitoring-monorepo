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
  maybePreloadPool,
  selfHealInvertRateFeed,
  upsertPool,
  upsertSnapshot,
} from "../../pool";
import { pickActiveThreshold } from "../../priceDifference";
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
// breached). Route through `upsertPool` so this event runs the same
// breach/health pipeline that state-sync handlers do — including
// `currentOpenBreachPeak` / `currentOpenBreachEntryThreshold` denorm
// maintenance, `selfHealInvertRateFeed` for the direction calc, and
// the `DeviationThresholdBreach` history row write. Then call
// `upsertSnapshot` to refresh the daily rollup, mirroring the oracle
// handlers — without it, threshold-only health transitions on a quiet
// pool can leave `PoolDailySnapshot.cumulativeHealth*` stale until the
// next reserve / oracle event.
FPMM.RebalanceThresholdUpdated.handler(async ({ event, context }) => {
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // Same preload-bail rationale as state-sync handlers: with
  // `preload_handlers: true` we'd otherwise run `recordBreachTransition`
  // (inside `upsertPool`) twice per event.
  if (await maybePreloadPool(context, poolId)) return;
  const initial = await context.Pool.get(poolId);
  if (!initial) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);
  // Self-heal invertRateFeed before pickActiveThreshold reads it. Without
  // this, an inverted pool whose deploy-time invert read failed and which
  // gets a threshold update before any state-sync event would persist
  // the wrong-side active threshold.
  const existing = await selfHealInvertRateFeed(context, initial);
  const above = Number(event.params.newThresholdAbove);
  const below = Number(event.params.newThresholdBelow);
  // Direction is determined by reservePrice vs. on-chain median; pass a
  // synthetic pool view that uses `lastMedianPrice` as the oracle source
  // so reporter-quote contamination of `oraclePrice` can't flip direction.
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
  const upserted = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_threshold_updated",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    oracleDelta: {
      rebalanceThresholdAbove: above,
      rebalanceThresholdBelow: below,
      rebalanceThreshold: active,
      rebalanceThresholdsKnown: true,
    },
    existing: { pool: existing },
  });
  // Advance the health-time accumulators so the interval since the last
  // sample is attributed against the pre-update deviationRatio. Without
  // this the next oracle/reserve event would attribute it against the
  // post-update ratio, inflating `healthBinarySeconds` for tightening
  // events on quiet pools. We discard `snapshotFields` because no
  // OracleSnapshot row is written for threshold-only events (the chart
  // history covers oracle reports + median updates, not governance
  // threshold changes).
  const { poolUpdate } = recordHealthSample(
    upserted,
    upserted.priceDifference,
    upserted.rebalanceThreshold,
    blockTimestamp,
  );
  const pool = { ...upserted, ...poolUpdate };
  context.Pool.set(pool);
  await upsertSnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
  });
});
