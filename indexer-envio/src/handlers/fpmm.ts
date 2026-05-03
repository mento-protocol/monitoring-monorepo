// ---------------------------------------------------------------------------
// FPMM event handlers
// ---------------------------------------------------------------------------

import {
  FPMM,
  type Pool,
  type SwapEvent,
  type ReserveUpdate,
  type RebalanceEvent,
  type OracleSnapshot,
  type TradingLimit,
} from "generated";
import { eventId, asAddress, asBigInt, makePoolId } from "../helpers";
import {
  ORACLE_ADAPTER_SCALE_FACTOR,
  buildRebalanceOutcome,
} from "../priceDifference";
import {
  TRADING_LIMITS_INTERNAL_DECIMALS,
  computeLimitPressures,
  computeLimitStatus,
} from "../tradingLimits";
import {
  fetchRebalancingState,
  fetchTradingLimits,
  fetchReserves,
  fetchRebalanceIncentiveAtBlock,
} from "../rpc";
import { computeRebalanceUsd, normalizeRewardBps } from "../usd";
import {
  DEFAULT_ORACLE_FIELDS,
  maybePreloadPool,
  upsertPool,
  upsertSnapshot,
} from "../pool";
import { recordHealthSample } from "../healthScore";

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
// FPMM.UpdateReserves
// ---------------------------------------------------------------------------

FPMM.UpdateReserves.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // Preload phase: signal Pool + open-breach-row dependencies so Envio
  // preloads them, then bail. All RPC + writes run only in processing.
  // Envio docs explicitly warn against direct `fetch` in preload — the
  // calls run twice per event (stale-data risk). Empirically, letting
  // RPC run in preload also caused in-batch Pool writes to not propagate
  // between sequential handlers, manifesting as breach rows closing
  // with `endedByEvent = "unknown"` even when a Rebalanced event fired
  // right after the UR handlers in the same tx. See `maybePreloadPool`.
  if (await maybePreloadPool(context, poolId)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // RPC and Pool.get are independent — fire in parallel to eliminate the
  // serial RTT. `context.Pool.get` only matters on the rebalancingState
  // success path (to read invertRateFeed), so the "waste" on the RPC-null
  // path is tolerable and already cached by Envio's in-batch store.
  // Use raw srcAddress for RPC calls (not the namespaced poolId).
  const [rebalancingState, existing] = await Promise.all([
    fetchRebalancingState(
      event.chainId,
      asAddress(event.srcAddress),
      blockNumber,
    ),
    context.Pool.get(poolId),
  ]);

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};
  // Hoist oraclePrice outside the if-block so it's accessible for OracleSnapshot
  // construction without a non-null assertion on oracleDelta.oraclePrice.
  let updateReservesOraclePrice = 0n;
  if (rebalancingState) {
    const isInverted = existing?.invertRateFeed ?? false;
    updateReservesOraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      oraclePrice: updateReservesOraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      priceDifference: rebalancingState.priceDifference,
      oracleTimestamp: blockTimestamp,
    };
  }

  let pool = await upsertPool({
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
    oracleDelta,
    // Reuse the Pool read from the concurrent Promise.all above — avoids
    // a second context.Pool.get inside getOrCreatePool.
    existing: { pool: existing },
  });

  if (rebalancingState) {
    // Health score: compute snapshot fields + update pool accumulators.
    // Note: upsertPool above calls context.Pool.set(pool) internally with
    // default health fields. We immediately overwrite with the correct
    // health accumulators here. Safe because Envio is single-threaded, but
    // the double-write is intentional — health update must come after upsertPool
    // so we have the final pool state to accumulate against.
    const { snapshotFields, poolUpdate } = recordHealthSample(
      pool,
      pool.priceDifference,
      pool.rebalanceThreshold,
      blockTimestamp,
    );
    // Reassign so the daily-snapshot upsert below freezes the just-updated
    // health counters, not the pre-recordHealthSample values.
    pool = { ...pool, ...poolUpdate };
    context.Pool.set(pool);
    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: updateReservesOraclePrice,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "update_reserves",
      blockNumber,
      txHash: event.transaction.hash,
      ...snapshotFields,
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
// FPMM.Rebalanced
// ---------------------------------------------------------------------------

FPMM.Rebalanced.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = makePoolId(event.chainId, event.srcAddress);
  // See UpdateReserves handler for the full rationale. Critical here
  // because FPMM emits 2× UR + 1× Rebalanced in the same rebalance tx
  // and we need sequential in-batch state visibility so Rebalanced sees
  // the anchor UR held.
  if (await maybePreloadPool(context, poolId)) return;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Fire RPC + Pool.get concurrently (see UpdateReserves handler).
  // Use raw srcAddress for RPC calls (not the namespaced poolId).
  // `preReserves` is sampled at `blockNumber - 1` so that subtracting from
  // the post-rebalance reserves on `pool` (after `upsertPool` below) gives
  // the rebalance's swap notional. Sibling Swap events are not emitted by
  // FPMM.rebalance() (separate code path), and the 2× UpdateReserves
  // handlers in the same tx have already overwritten the entity by the
  // time we run — RPC at the previous block is the cleanest source.
  // We sequence the Pool.get first (cheap local lookup, no RPC) so we can
  // skip `fetchRebalanceIncentiveAtBlock` for pools whose `rebalanceIncentive()`
  // getter is already known missing (-2 sentinel from PR #222) — otherwise
  // every rebalance on an old FPMM would trigger an RPC that's guaranteed
  // to fail with `isUnsupportedGetterError`.
  const existing = await context.Pool.get(poolId);
  const incentiveGetterMissing = existing?.rebalanceReward === -2;
  const [rebalancingState, preReserves, blockScopedIncentive] =
    await Promise.all([
      fetchRebalancingState(
        event.chainId,
        asAddress(event.srcAddress),
        blockNumber,
      ),
      fetchReserves(
        event.chainId,
        asAddress(event.srcAddress),
        blockNumber - 1n,
      ),
      // Read at the event block — `Pool.rebalanceReward` may carry today's
      // value during full resync (fetchFees self-heals from `latest`), and
      // we want the bps that was actually in force when this rebalance
      // executed. Falls back to `pool.rebalanceReward` below on RPC failure
      // or block-fallback. Skipped for `-2` sentinel pools per the comment
      // above — propagate the sentinel so `normalizeRewardBps` sees it.
      incentiveGetterMissing
        ? Promise.resolve(-2)
        : fetchRebalanceIncentiveAtBlock(
            event.chainId,
            asAddress(event.srcAddress),
            blockNumber,
          ),
    ]);

  const rebalancerAddress = asAddress(event.params.sender);

  // Prefer the RPC-read threshold (matches what the contract just used);
  // fall back to the persisted Pool row if the RPC failed.
  const rebalanceThresholdForEvent =
    rebalancingState?.rebalanceThreshold ?? existing?.rebalanceThreshold ?? 0;
  const priceDifferenceBefore = event.params.priceDifferenceBefore;
  const priceDifferenceAfter = event.params.priceDifferenceAfter;
  const { improvement, lastEffectivenessRatio, eventEffectivenessRatio } =
    buildRebalanceOutcome({
      priceDifferenceBefore,
      priceDifferenceAfter,
      rebalanceThreshold: rebalanceThresholdForEvent,
    });

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {
    lastRebalancedAt: blockTimestamp,
    rebalancerAddress,
    rebalanceLivenessStatus: "ACTIVE",
    priceDifference: event.params.priceDifferenceAfter,
    lastEffectivenessRatio,
  };

  // Hoist oraclePrice outside the if-block so it's accessible for OracleSnapshot
  // construction without a non-null assertion on oracleDelta.oraclePrice.
  let rebalancedOraclePrice = 0n;
  if (rebalancingState) {
    const isInverted = existing?.invertRateFeed ?? false;
    rebalancedOraclePrice = isInverted
      ? rebalancingState.oraclePriceDenominator * ORACLE_ADAPTER_SCALE_FACTOR
      : rebalancingState.oraclePriceNumerator * ORACLE_ADAPTER_SCALE_FACTOR;

    oracleDelta = {
      ...oracleDelta,
      oraclePrice: rebalancedOraclePrice,
      rebalanceThreshold: rebalancingState.rebalanceThreshold,
      oracleTimestamp: blockTimestamp,
    };
  }

  let pool = await upsertPool({
    context,
    chainId: event.chainId,
    poolId,
    source: "fpmm_rebalanced",
    blockNumber,
    blockTimestamp,
    txHash: event.transaction.hash,
    strategy: rebalancerAddress,
    rebalanceDelta: true,
    oracleDelta,
    // Reuse the Pool read from the concurrent Promise.all above.
    existing: { pool: existing },
  });

  if (rebalancingState) {
    // Health score: compute snapshot fields + update pool accumulators.
    // Note: upsertPool above calls context.Pool.set(pool) internally with
    // default health fields. We immediately overwrite with the correct
    // health accumulators here. Safe because Envio is single-threaded, but
    // the double-write is intentional — health update must come after upsertPool
    // so we have the final pool state to accumulate against.
    const { snapshotFields, poolUpdate } = recordHealthSample(
      pool,
      pool.priceDifference,
      pool.rebalanceThreshold,
      blockTimestamp,
    );
    // Reassign so the daily-snapshot upsert below freezes the just-updated
    // health counters, not the pre-recordHealthSample values.
    pool = { ...pool, ...poolUpdate };
    context.Pool.set(pool);

    const snapshot: OracleSnapshot = {
      id: eventId(event.chainId, event.block.number, event.logIndex),
      chainId: event.chainId,
      poolId,
      timestamp: blockTimestamp,
      oraclePrice: rebalancedOraclePrice,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      rebalanceThreshold: pool.rebalanceThreshold,
      source: "rebalanced",
      blockNumber,
      txHash: event.transaction.hash,
      ...snapshotFields,
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

  // Reserve deltas (post − pre). On RPC failure of `fetchReserves` at
  // `blockNumber - 1`, both deltas stay 0, which `computeRebalanceUsd`
  // recognizes as the uncomputable case → "" sentinel for both USD fields.
  const amount0Delta = preReserves ? pool.reserves0 - preReserves.reserve0 : 0n;
  const amount1Delta = preReserves ? pool.reserves1 - preReserves.reserve1 : 0n;
  // No fallback to `pool.rebalanceReward` here: that field can be `latest`-
  // seeded by upsertPool's self-heal (`fetchFees` is not block-scoped),
  // which would re-introduce the historical-drift bug the block-scoped read
  // was added to prevent. When the block-scoped read fails (RPC failure or
  // `latest`-block fallback), `rewardBps` falls to 0 for arithmetic, but
  // `rewardUsd` is forced to "" below so a real zero-incentive rebalance
  // ("$0.00") stays distinguishable from "incentive unknown" ("—").
  const incentiveUnknown = blockScopedIncentive === null;
  const rewardBps = normalizeRewardBps(blockScopedIncentive ?? 0);
  const { notionalUsd, rewardUsd: computedRewardUsd } = computeRebalanceUsd({
    chainId: event.chainId,
    token0: pool.token0,
    token1: pool.token1,
    token0Decimals: pool.token0Decimals,
    token1Decimals: pool.token1Decimals,
    amount0Delta,
    amount1Delta,
    rewardBps,
  });
  const rewardUsd = incentiveUnknown ? "" : computedRewardUsd;

  const rebalanced: RebalanceEvent = {
    id,
    chainId: event.chainId,
    poolId,
    sender: rebalancerAddress,
    caller: event.transaction.from ?? "",
    priceDifferenceBefore,
    priceDifferenceAfter,
    improvement,
    rebalanceThreshold: rebalanceThresholdForEvent,
    effectivenessRatio: eventEffectivenessRatio,
    amount0Delta,
    amount1Delta,
    rewardBps,
    notionalUsd,
    rewardUsd,
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
