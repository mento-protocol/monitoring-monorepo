// ---------------------------------------------------------------------------
// FPMM state-sync handlers: UpdateReserves + Rebalanced
// ---------------------------------------------------------------------------
//
// Two-cursor model (PR 1.5 design decision):
//
// On orientation-unknown events (pool deployed during a deploy-time RPC blip
// where `invertRateFeedKnown=false` survived self-heal):
//
//  1. Pool entity ADVANCES on every event — `priceDifference`,
//     `rebalanceThreshold`, reserves, breach state. The contract values are
//     authoritative regardless of our local `invertRateFeed` flag, so breach
//     detection / health badges always read current state.
//
//  2. `oraclePrice` + `oracleTimestamp` HOLD on the prior values when
//     orientation is unknown. Advancing them with a guess from the schema
//     default would mark stale data as freshly updated under the
//     diagnostics. Contract freshness is tracked separately by the exact
//     `lastOracleReportAt + oracleExpiry` anchor.
//
//  3. OracleSnapshot row SKIPPED when orientation is unknown. A row whose
//     displayed `oraclePrice` doesn't match its `priceDifference` would be
//     worse than no row — chart history would show a fabricated sample.
//
// The cursor (Pool entity) and the snapshot stream (OracleSnapshot rows) are
// allowed to drift here. It's a feature, not a bug: breach detection stays
// current, chart history stays trustworthy. Cursor → invariants advance
// freely; OracleSnapshot → only writes data we believe in.
// ---------------------------------------------------------------------------

import type {
  EvmOnEventContext,
  OracleSnapshot,
  Pool,
  RebalanceEvent,
  ReserveUpdate,
} from "envio";
import { indexer } from "../../indexer.js";
import { eventId, asAddress, asBigInt, makePoolId } from "../../helpers.js";
import {
  buildRebalanceOutcome,
  classifyExactZeroReserves,
  hasDegenerateReserves,
} from "../../priceDifference.js";
import { reservesEffect } from "../../rpc/effects.js";
import { computeRebalanceUsd, normalizeRewardBps } from "../../usd.js";
import {
  DEFAULT_ORACLE_FIELDS,
  computeHealthStatus,
  effectiveThreshold,
  isNeverRebalance,
  persistableThreshold,
  maybePreloadPool,
  selfHealInvertRateFeed,
  selfHealRebalanceThresholds,
  selfHealTokenDecimals,
  upsertPool,
  upsertSnapshot,
} from "../../pool.js";
import { recordHealthSample } from "../../healthScore.js";
import { shouldPersistRawOracleSnapshot } from "../../oracleSnapshotRetention.js";
import {
  readStateSyncEffects,
  type RebalancedEvent,
  type UpdateReservesEvent,
} from "./state-sync-effects.js";

type DegenerateReservePool = Pick<
  Pool,
  | "tokenDecimalsKnown"
  | "token0Decimals"
  | "token1Decimals"
  | "reserves0"
  | "reserves1"
  | "degenerateReserves"
>;

function degenerateReservesForPool(
  pool: DegenerateReservePool | undefined,
  reserves?: { reserve0: bigint; reserve1: bigint },
): boolean {
  if (reserves) {
    const exactZeroState = classifyExactZeroReserves({
      reserves0: reserves.reserve0,
      reserves1: reserves.reserve1,
    });
    if (exactZeroState !== undefined) return exactZeroState;
  }
  if (!pool || pool.tokenDecimalsKnown !== true)
    return pool?.degenerateReserves ?? false;
  return hasDegenerateReserves({
    reserves0: reserves?.reserve0 ?? pool.reserves0,
    reserves1: reserves?.reserve1 ?? pool.reserves1,
    token0Decimals: pool.token0Decimals,
    token1Decimals: pool.token1Decimals,
  });
}

/** Persist the health cursor and optional diagnostic row shared by both
 * state-sync handlers. The Pool write must follow `upsertPool` because it
 * accumulates against the final event state. */
function recordStateSyncHealth(args: {
  blockNumber: bigint;
  blockTimestamp: bigint;
  chainId: number;
  context: EvmOnEventContext;
  pool: Pool;
  priorPool: Pool | undefined;
  poolId: string;
  snapshotId: string;
  snapshotOraclePrice: bigint;
  snapshotSource: "rebalanced" | "update_reserves";
  shouldRecord: boolean;
  shouldSnapshot: boolean;
  txHash: string;
}): Pool {
  if (!args.shouldRecord) return args.pool;

  const { snapshotFields, poolUpdate } = recordHealthSample(
    args.pool,
    args.pool.priceDifference,
    Number(effectiveThreshold(args.pool)),
    {
      blockTimestamp: args.blockTimestamp,
      isNeverRebalance: isNeverRebalance(args.pool),
      priorOracleFreshness: {
        reportTimestamp: args.priorPool?.lastOracleReportAt ?? 0n,
        expiry: args.priorPool?.oracleExpiry ?? 0n,
      },
    },
  );
  const merged = { ...args.pool, ...poolUpdate };
  const pool = {
    ...merged,
    healthStatus: computeHealthStatus(merged, args.blockTimestamp),
  };
  args.context.Pool.set(pool);

  if (args.shouldSnapshot) {
    const snapshot: OracleSnapshot = {
      id: args.snapshotId,
      chainId: args.chainId,
      poolId: args.poolId,
      timestamp: args.blockTimestamp,
      oraclePrice: args.snapshotOraclePrice,
      oracleOk: pool.oracleOk,
      numReporters: pool.oracleNumReporters,
      priceDifference: pool.priceDifference,
      degenerateReserves: pool.degenerateReserves,
      rebalanceThreshold: persistableThreshold(pool),
      source: args.snapshotSource,
      blockNumber: args.blockNumber,
      txHash: args.txHash,
      // State-sync rows measure pool-internal deviation, not oracle
      // deviation, so BreakerBox does not evaluate this path.
      breakerBaselineAtSnapshot: undefined,
      breakerThresholdAtSnapshot: undefined,
      ...snapshotFields,
    };
    if (shouldPersistRawOracleSnapshot(args.blockTimestamp)) {
      args.context.OracleSnapshot.set(snapshot);
    }
  }

  return pool;
}

type StateSyncHandlerArgs<E> = { event: E; context: EvmOnEventContext };

// Handler bodies are exported so tests can drive the preload pass directly;
// the test harness has no preload hook. Registration follows the object.
export const stateSyncHandlers = {
  // -------------------------------------------------------------------------
  // FPMM.UpdateReserves
  // -------------------------------------------------------------------------
  UpdateReserves: async ({
    event,
    context,
  }: StateSyncHandlerArgs<UpdateReservesEvent>): Promise<void> => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.srcAddress);
    // Preload warms the Pool and open breach row, then requests rows 1-4
    // through the shared reader, keyed from the preload Pool. It writes no
    // entity, calls no `upsertPool` and leaves the reserve scratch alone:
    // an earlier attempt that ran handler state logic in preload closed
    // breach rows with `endedByEvent = "unknown"`. Processing re-derives
    // every gate from ordered state.
    // preload-handler-note: rows 1-4 are awaited in preload through readStateSyncEffects; self-heal and upsertPool stay processing-only because ordered same-tx Pool writes must reach later events.
    // preload-effect-helpers: selfHealInvertRateFeed, selfHealTokenDecimals
    // preload-effect-helpers: selfHealRebalanceThresholds, readStateSyncEffects
    // preload-effect-helpers: upsertPool
    if (await maybePreloadPool(context, poolId)) {
      await readStateSyncEffects(
        context,
        event,
        await context.Pool.get(poolId),
      );
      return;
    }
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
          await selfHealTokenDecimals(
            context,
            await selfHealInvertRateFeed(context, fetched),
          ),
          blockNumber,
        )
      : undefined;

    captureExistingTxPreRebalanceReserves(
      event.chainId,
      poolId,
      event.transaction.hash,
      blockNumber,
      existing,
    );
    const {
      medianTimestamp: authoritativeMedianTimestamp,
      oracleFreshnessProven,
      resolved,
    } = (await readStateSyncEffects(context, event, existing)).authoritative;

    let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {};
    const updateReservesDegenerate = degenerateReservesForPool(existing, {
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    });
    // If state resolution fails, `oracleDelta` stays empty and `upsertPool`
    // recomputes degenerateReserves from the just-applied reservesDelta,
    // including the decimals-independent exact-zero reserve case.
    // Only persist the scaled oraclePrice + timestamp when we know the
    // orientation. On the RPC-fallback path with `invertRateFeedKnown=false`
    // (deploy blip + self-heal failure), `scaleRpcRebalanceState` would
    // have chosen numerator vs denominator from the schema-default `false`,
    // so the displayed oraclePrice could be backwards for actually-inverted
    // pools. The contract's threshold + priceDifference are authoritative
    // regardless of our local flag, so we still persist those. Preserve
    // the existing `oraclePrice` AND `oracleTimestamp` when orientation
    // is unknown — advancing a raw observation timestamp without a usable
    // price would make the diagnostic cursor internally inconsistent.
    const orientationKnown = existing?.invertRateFeedKnown === true;
    let updateReservesOraclePrice = 0n;
    if (resolved) {
      updateReservesOraclePrice = orientationKnown
        ? resolved.oraclePrice
        : (existing?.oraclePrice ?? 0n);
      oracleDelta = {
        rebalanceThreshold: resolved.rebalanceThreshold,
        priceDifference: resolved.priceDifference,
        degenerateReserves: updateReservesDegenerate,
        // Promote freshness only when the state read is paired with the exact
        // positive median anchor for this block. The state RPC alone cannot
        // repair an indexer row whose freshness cursor is still unknown.
        ...(oracleFreshnessProven ? { oracleOk: true } : {}),
        ...(authoritativeMedianTimestamp !== null
          ? { lastOracleReportAt: authoritativeMedianTimestamp }
          : {}),
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
      logIndex: event.logIndex,
      reservesDelta: {
        reserve0: event.params.reserve0,
        reserve1: event.params.reserve1,
      },
      oracleDelta,
      // Reuse the Pool read from above — avoids a second context.Pool.get
      // inside getOrCreatePool.
      existing: { pool: existing },
    });

    const recordDegenerateHealthBoundary =
      !resolved && updateReservesDegenerate && pool.degenerateReserves;
    pool = recordStateSyncHealth({
      blockNumber,
      blockTimestamp,
      chainId: event.chainId,
      context,
      pool,
      priorPool: existing,
      poolId,
      snapshotId: id,
      snapshotOraclePrice: updateReservesOraclePrice,
      snapshotSource: "update_reserves",
      shouldRecord: Boolean(resolved) || recordDegenerateHealthBoundary,
      // Unknown orientation would pair a fresh deviation with a stale price.
      shouldSnapshot: Boolean(resolved) && orientationKnown,
      txHash: event.transaction.hash,
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
  },

  // -------------------------------------------------------------------------
  // FPMM.Rebalanced
  // -------------------------------------------------------------------------
  // eslint-disable-next-line max-lines-per-function -- Existing handler keeps same-event reserve, breach, and rebalance writes together for ordering parity.
  Rebalanced: async ({
    event,
    context,
  }: StateSyncHandlerArgs<RebalancedEvent>): Promise<void> => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = makePoolId(event.chainId, event.srcAddress);
    // See UpdateReserves for the preload contract. Critical here because
    // FPMM emits 2× UR + 1× Rebalanced in the same rebalance tx and we need
    // sequential in-batch state visibility so Rebalanced sees the anchor UR
    // held. Preload keys row 4 from the preload Pool as well.
    // preload-handler-note: rows 1-4 are awaited in preload through readStateSyncEffects; self-heal and upsertPool stay processing-only because ordered same-tx Pool writes must reach this event.
    // preload-effect-helpers: selfHealInvertRateFeed, selfHealTokenDecimals
    // preload-effect-helpers: selfHealRebalanceThresholds, readStateSyncEffects
    // preload-effect-helpers: upsertPool
    if (await maybePreloadPool(context, poolId)) {
      await readStateSyncEffects(
        context,
        event,
        await context.Pool.get(poolId),
      );
      return;
    }
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
          await selfHealTokenDecimals(
            context,
            await selfHealInvertRateFeed(context, initial),
          ),
          blockNumber,
        )
      : undefined;
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
    // add an `existing.lastReserveUpdateBlock < blockNumber` guard in
    // `readStateSyncEffects`, which derives from `existing` below.

    // Prefer the in-batch Pool state captured before the first UpdateReserves
    // in this transaction. Sampling `blockNumber - 1` here is only an explicit
    // unknown fallback: same-block unrelated reserve changes may already have
    // legitimately advanced the Pool before this rebalance tx begins.
    const txScopedPreReserves = consumeTxPreRebalanceReserves({
      chainId: event.chainId,
      poolId,
      txHash: event.transaction.hash,
      blockNumber,
    });
    const preReservesPromise = preReservesOrFallback(txScopedPreReserves, () =>
      // preload-effect-exempt: ordered same-tx reserves are required; see docs/PLAN-indexer-preload-state-sync.md reserve scratch follow-up.
      context.effect(reservesEffect, {
        chainId: event.chainId,
        poolAddress: asAddress(event.srcAddress),
        blockNumber: blockNumber - 1n,
      }),
    );
    const [
      { authoritative: authoritativeState, blockScopedIncentive },
      preReserves,
    ] = await Promise.all([
      readStateSyncEffects(context, event, existing),
      preReservesPromise,
    ]);

    const resolved = authoritativeState.resolved;

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
    const rebalancedDegenerate = degenerateReservesForPool(existing);

    let oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> = {
      lastRebalancedAt: blockTimestamp,
      rebalancerAddress,
      rebalanceLivenessStatus: "ACTIVE",
      priceDifference: event.params.priceDifferenceAfter,
      degenerateReserves: rebalancedDegenerate,
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
        // Match UpdateReserves: require the exact positive median anchor
        // before repairing the persisted live-oracle flag.
        ...(authoritativeState.oracleFreshnessProven ? { oracleOk: true } : {}),
        ...(authoritativeState.medianTimestamp !== null
          ? { lastOracleReportAt: authoritativeState.medianTimestamp }
          : {}),
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
      logIndex: event.logIndex,
      strategy: rebalancerAddress,
      rebalanceDelta: true,
      oracleDelta,
      // Reuse the Pool read from above — avoids a second context.Pool.get
      // inside getOrCreatePool.
      existing: { pool: existing },
    });

    pool = recordStateSyncHealth({
      blockNumber,
      blockTimestamp,
      chainId: event.chainId,
      context,
      pool,
      priorPool: existing,
      poolId,
      snapshotId: id,
      snapshotOraclePrice: rebalancedOraclePrice,
      snapshotSource: "rebalanced",
      shouldRecord: Boolean(resolved),
      shouldSnapshot: Boolean(resolved) && rebalancedOrientationKnown,
      txHash: event.transaction.hash,
    });

    await upsertSnapshot({
      context,
      pool,
      blockTimestamp,
      blockNumber,
      rebalanceDelta: true,
    });

    const { amount0Delta, amount1Delta, rewardBps, notionalUsd, rewardUsd } =
      buildRebalanceValueFields({
        pool,
        preReserves,
        blockScopedIncentive,
      });

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
  },
};

indexer.onEvent(
  { contract: "FPMM", event: "UpdateReserves" },
  async ({ event, context }) =>
    stateSyncHandlers.UpdateReserves({ event, context }),
);

indexer.onEvent(
  { contract: "FPMM", event: "Rebalanced" },
  async ({ event, context }) =>
    stateSyncHandlers.Rebalanced({ event, context }),
);

type ReservePair = {
  reserve0: bigint;
  reserve1: bigint;
};

type TxPreRebalanceReserves = ReservePair & {
  blockNumber: bigint;
};

type PoolReserveSnapshot = {
  reserves0: bigint;
  reserves1: bigint;
};

const txPreRebalanceReserves = new Map<string, TxPreRebalanceReserves>();

function txReserveScratchKey(
  chainId: number,
  poolId: string,
  txHash: string,
): string {
  return `${chainId}:${poolId}:${txHash.toLowerCase()}`;
}

function pruneOldTxPreRebalanceReserves(blockNumber: bigint): void {
  for (const [key, snapshot] of txPreRebalanceReserves) {
    if (snapshot.blockNumber < blockNumber) {
      // phase-state-exempt: bounded ordered same-tx reserve scratch; remove with the docs/PLAN-indexer-preload-state-sync.md reserve scratch follow-up (plan: #2528).
      txPreRebalanceReserves.delete(key);
    }
  }
}

function captureExistingTxPreRebalanceReserves(
  chainId: number,
  poolId: string,
  txHash: string,
  blockNumber: bigint,
  existing: PoolReserveSnapshot | undefined,
): void {
  if (!existing) return;
  captureTxPreRebalanceReserves({
    chainId,
    poolId,
    txHash,
    blockNumber,
    reserves: {
      reserve0: existing.reserves0,
      reserve1: existing.reserves1,
    },
  });
}

function captureTxPreRebalanceReserves(args: {
  chainId: number;
  poolId: string;
  txHash: string;
  blockNumber: bigint;
  reserves: ReservePair;
}): void {
  pruneOldTxPreRebalanceReserves(args.blockNumber);
  const key = txReserveScratchKey(args.chainId, args.poolId, args.txHash);
  if (txPreRebalanceReserves.has(key)) return;
  // phase-state-exempt: bounded ordered same-tx reserve scratch; remove with the docs/PLAN-indexer-preload-state-sync.md reserve scratch follow-up (plan: #2528).
  txPreRebalanceReserves.set(key, {
    ...args.reserves,
    blockNumber: args.blockNumber,
  });
}

function consumeTxPreRebalanceReserves(args: {
  chainId: number;
  poolId: string;
  txHash: string;
  blockNumber: bigint;
}): ReservePair | null {
  pruneOldTxPreRebalanceReserves(args.blockNumber);
  const key = txReserveScratchKey(args.chainId, args.poolId, args.txHash);
  const snapshot = txPreRebalanceReserves.get(key);
  if (!snapshot) return null;
  // phase-state-exempt: bounded ordered same-tx reserve scratch; remove with the docs/PLAN-indexer-preload-state-sync.md reserve scratch follow-up (plan: #2528).
  txPreRebalanceReserves.delete(key);
  return snapshot.blockNumber === args.blockNumber
    ? { reserve0: snapshot.reserve0, reserve1: snapshot.reserve1 }
    : null;
}

function preReservesOrFallback(
  txScopedPreReserves: ReservePair | null,
  fallback: () => Promise<ReservePair | null>,
): Promise<ReservePair | null> {
  return txScopedPreReserves
    ? Promise.resolve(txScopedPreReserves)
    : fallback();
}

function reserveDeltas(
  pool: Pool,
  preReserves: ReservePair | null,
): ReservePair {
  if (!preReserves) return { reserve0: 0n, reserve1: 0n };
  return {
    reserve0: pool.reserves0 - preReserves.reserve0,
    reserve1: pool.reserves1 - preReserves.reserve1,
  };
}

function buildRebalanceValueFields({
  pool,
  preReserves,
  blockScopedIncentive,
}: {
  pool: Pool;
  preReserves: ReservePair | null;
  blockScopedIncentive: number | null;
}): {
  amount0Delta: bigint;
  amount1Delta: bigint;
  rewardBps: number;
  notionalUsd: string;
  rewardUsd: string;
} {
  const deltas = reserveDeltas(pool, preReserves);
  const rewardBps = normalizeRewardBps(blockScopedIncentive ?? 0);
  const { notionalUsd, rewardUsd } = computeRebalanceUsd({
    chainId: pool.chainId,
    token0: pool.token0,
    token1: pool.token1,
    token0Decimals: pool.token0Decimals,
    token1Decimals: pool.token1Decimals,
    tokenDecimalsKnown: pool.tokenDecimalsKnown,
    amount0Delta: deltas.reserve0,
    amount1Delta: deltas.reserve1,
    rewardBps,
  });
  return {
    amount0Delta: deltas.reserve0,
    amount1Delta: deltas.reserve1,
    rewardBps,
    notionalUsd,
    rewardUsd: blockScopedIncentive === null ? "" : rewardUsd,
  };
}
