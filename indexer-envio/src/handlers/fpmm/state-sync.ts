// ---------------------------------------------------------------------------
// FPMM state-sync handlers: UpdateReserves + Rebalanced
// ---------------------------------------------------------------------------

import {
  FPMM,
  type OracleSnapshot,
  type ReserveUpdate,
  type RebalanceEvent,
} from "generated";
import { eventId, asAddress, asBigInt, makePoolId } from "../../helpers";
import {
  buildRebalanceOutcome,
  scaleRpcRebalanceState,
  tryDeriveRebalanceState,
  type ResolvedRebalanceState,
} from "../../priceDifference";
import {
  rebalanceIncentiveAtBlockEffect,
  rebalancingStateEffect,
  reservesEffect,
} from "../../rpc/effects";
import { computeRebalanceUsd, normalizeRewardBps } from "../../usd";
import {
  DEFAULT_ORACLE_FIELDS,
  maybePreloadPool,
  selfHealInvertRateFeed,
  selfHealRebalanceThresholds,
  upsertPool,
  upsertSnapshot,
} from "../../pool";
import { recordHealthSample } from "../../healthScore";

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

  // Try to derive {oraclePrice, rebalanceThreshold, priceDifference} from
  // the entity store before reaching for the RPC. Pool.get must come first
  // so the derive attempt can run; the RPC fires only when the entity
  // isn't yet seeded (cold-start: pre-MedianUpdated for the feed, or
  // pre-RebalanceThresholdUpdated seed).
  const fetched = await context.Pool.get(poolId);
  // Self-heal invertRateFeed and split thresholds before reading either.
  // invertRateFeed gates oraclePrice direction; split thresholds gate the
  // entity-derived path. A factory-time RPC blip that left either at the
  // schema default would otherwise persist wrong-side oraclePrice or
  // permanently disable derive (forcing every event back to RPC).
  const existing = fetched
    ? await selfHealRebalanceThresholds(
        context,
        await selfHealInvertRateFeed(context, fetched),
        blockNumber,
      )
    : undefined;

  // Override reserves: `getRebalancingState` reads post-event state on
  // chain, but `existing.reserves0/1` still hold the prior block's value
  // until `upsertPool` runs below.
  let resolved: ResolvedRebalanceState | null = existing
    ? tryDeriveRebalanceState(existing, {
        eventTimestamp: blockTimestamp,
        reservesOverride: {
          reserve0: event.params.reserve0,
          reserve1: event.params.reserve1,
        },
      })
    : null;
  if (!resolved) {
    const rs = await context.effect(rebalancingStateEffect, {
      chainId: event.chainId,
      poolAddress: asAddress(event.srcAddress),
      blockNumber,
    });
    resolved = rs ? scaleRpcRebalanceState(rs, existing) : null;
  }

  let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};
  // Only persist the scaled oraclePrice + timestamp when we know the
  // orientation. On the RPC-fallback path with `invertRateFeedKnown=false`
  // (deploy blip + self-heal failure), `scaleRpcRebalanceState` would
  // have chosen numerator vs denominator from the schema-default `false`,
  // so the displayed oraclePrice could be backwards for actually-inverted
  // pools. The contract's threshold + priceDifference are authoritative
  // regardless of our local flag, so we still persist those. Preserve
  // the existing `oraclePrice` AND `oracleTimestamp` when orientation
  // is unknown — advancing the timestamp without a usable price would
  // mark stale data as freshly updated under the
  // `oracleTimestamp + oracleExpiry` freshness check.
  const orientationKnown = existing?.invertRateFeedKnown === true;
  let updateReservesOraclePrice = 0n;
  if (resolved) {
    updateReservesOraclePrice = orientationKnown
      ? resolved.oraclePrice
      : (existing?.oraclePrice ?? 0n);
    oracleDelta = {
      rebalanceThreshold: resolved.rebalanceThreshold,
      priceDifference: resolved.priceDifference,
      ...(orientationKnown
        ? {
            oraclePrice: updateReservesOraclePrice,
            oracleTimestamp: blockTimestamp,
          }
        : {}),
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
    // Reuse the Pool read from above — avoids a second context.Pool.get
    // inside getOrCreatePool.
    existing: { pool: existing },
  });

  if (resolved) {
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
      id,
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

  // Sequence Pool.get first (cheap local lookup, no RPC) so we can
  // (a) attempt the entity-derived rebalanceState and skip the
  //     `getRebalancingState` RPC entirely when the entity has the data,
  // (b) skip `fetchRebalanceIncentiveAtBlock` for pools whose
  //     `rebalanceIncentive()` getter is already known missing (-2 sentinel
  //     from PR #222) — otherwise every rebalance on an old FPMM would
  //     trigger an RPC that's guaranteed to fail with `isUnsupportedGetterError`.
  const initial = await context.Pool.get(poolId);
  // Self-heal invertRateFeed + split thresholds before reading either.
  // Same rationale as the UpdateReserves handler.
  const existing = initial
    ? await selfHealRebalanceThresholds(
        context,
        await selfHealInvertRateFeed(context, initial),
        blockNumber,
      )
    : undefined;
  const incentiveGetterMissing = initial?.rebalanceReward === -2;
  // Load-bearing invariant: FPMM.rebalance() emits 2× UpdateReserves +
  // 1× Rebalanced in the SAME tx, with Rebalanced at a higher logIndex.
  // Envio processes events in ascending (block, logIndex) order, so by
  // the time this handler runs the prior UR handlers in the same tx
  // have already written post-rebalance reserves to the Pool entity.
  // `existing.reserves0/1` therefore matches what the contract's
  // `getRebalancingState` sees on chain — no override needed. If a
  // future Envio version changes batch semantics or a chain emits
  // Rebalanced before its sibling URs (no known case), the derive
  // would silently use stale reserves; the caller would still fall
  // back to RPC only when derive returns null, so the fix would be to
  // add an `existing.lastReserveUpdateBlock < blockNumber` guard here.
  const derivedRebalanceState = existing
    ? tryDeriveRebalanceState(existing, { eventTimestamp: blockTimestamp })
    : null;

  // `preReserves` is sampled at `blockNumber - 1` so subtracting from the
  // post-rebalance reserves on `pool` (after `upsertPool` below) gives the
  // rebalance's swap notional. Sibling Swap events are not emitted by
  // FPMM.rebalance() (separate code path).
  const [rebalancingStateRpc, preReserves, blockScopedIncentive] =
    await Promise.all([
      derivedRebalanceState
        ? Promise.resolve(undefined)
        : context.effect(rebalancingStateEffect, {
            chainId: event.chainId,
            poolAddress: asAddress(event.srcAddress),
            blockNumber,
          }),
      context.effect(reservesEffect, {
        chainId: event.chainId,
        poolAddress: asAddress(event.srcAddress),
        blockNumber: blockNumber - 1n,
      }),
      // Read at the event block — `Pool.rebalanceReward` may carry today's
      // value during full resync (fetchFees self-heals from `latest`), and
      // we want the bps that was actually in force when this rebalance
      // executed. Falls back to `pool.rebalanceReward` below on RPC failure
      // or block-fallback. Skipped for `-2` sentinel pools per the comment
      // above — propagate the sentinel so `normalizeRewardBps` sees it.
      incentiveGetterMissing
        ? Promise.resolve(-2)
        : context.effect(rebalanceIncentiveAtBlockEffect, {
            chainId: event.chainId,
            poolAddress: asAddress(event.srcAddress),
            blockNumber,
          }),
    ]);

  const resolved: ResolvedRebalanceState | null =
    derivedRebalanceState ??
    (rebalancingStateRpc
      ? scaleRpcRebalanceState(rebalancingStateRpc, existing)
      : null);

  const rebalancerAddress = asAddress(event.params.sender);

  // Prefer the resolved threshold (whether entity-derived or RPC-read —
  // both reflect the direction-correct active threshold for this block).
  // Fall back to the persisted Pool row if both paths failed.
  const rebalanceThresholdForEvent =
    resolved?.rebalanceThreshold ?? existing?.rebalanceThreshold ?? 0;
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
  // Same orientation gate as UpdateReserves: only persist scaled
  // oraclePrice + timestamp when `invertRateFeedKnown`. RPC fallback's
  // scale calc can guess wrong if the deploy-time invert read failed,
  // and advancing the timestamp without a usable price would falsely
  // mark stale data as fresh under the freshness gate.
  const rebalancedOrientationKnown = existing?.invertRateFeedKnown === true;
  let rebalancedOraclePrice = 0n;
  if (resolved) {
    rebalancedOraclePrice = rebalancedOrientationKnown
      ? resolved.oraclePrice
      : (existing?.oraclePrice ?? 0n);
    oracleDelta = {
      ...oracleDelta,
      rebalanceThreshold: resolved.rebalanceThreshold,
      ...(rebalancedOrientationKnown
        ? {
            oraclePrice: rebalancedOraclePrice,
            oracleTimestamp: blockTimestamp,
          }
        : {}),
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
    // Reuse the Pool read from above — avoids a second context.Pool.get
    // inside getOrCreatePool.
    existing: { pool: existing },
  });

  if (resolved) {
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
      id,
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
  // Effect output is `number | undefined` (Sury's nullable maps null →
  // undefined), so check for undefined to capture the RPC-failure path.
  const incentiveUnknown = blockScopedIncentive === undefined;
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
