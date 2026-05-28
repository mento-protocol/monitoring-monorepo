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
//     `oracleTimestamp + oracleExpiry` freshness check.
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
  OracleSnapshot,
  Pool,
  RebalanceEvent,
  ReserveUpdate,
} from "envio";
import { indexer } from "../../indexer.js";
import { eventId, asAddress, asBigInt, makePoolId } from "../../helpers.js";
import {
  buildRebalanceOutcome,
  hasDegenerateReserves,
  scaleRpcRebalanceState,
  tryDeriveRebalanceState,
  type ResolvedRebalanceState,
} from "../../priceDifference.js";
import {
  rebalanceIncentiveAtBlockEffect,
  rebalancingStateEffect,
  reservesEffect,
} from "../../rpc/effects.js";
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
  if (!pool || pool.tokenDecimalsKnown !== true)
    return pool?.degenerateReserves ?? false;
  return hasDegenerateReserves({
    reserves0: reserves?.reserve0 ?? pool.reserves0,
    reserves1: reserves?.reserve1 ?? pool.reserves1,
    token0Decimals: pool.token0Decimals,
    token1Decimals: pool.token1Decimals,
  });
}

// ---------------------------------------------------------------------------
// FPMM.UpdateReserves
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "UpdateReserves" },
  async ({ event, context }) => {
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
    const updateReservesDegenerate = degenerateReservesForPool(existing, {
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    });
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
        degenerateReserves: updateReservesDegenerate,
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

    if (resolved) {
      // Health score: compute snapshot fields + update pool accumulators.
      // Note: upsertPool above calls context.Pool.set(pool) internally with
      // default health fields. We immediately overwrite with the correct
      // health accumulators here. Safe because Envio is single-threaded, but
      // the double-write is intentional — health update must come after upsertPool
      // so we have the final pool state to accumulate against.
      const effectiveBps = Number(effectiveThreshold(pool));
      const { snapshotFields, poolUpdate } = recordHealthSample(
        pool,
        pool.priceDifference,
        effectiveBps,
        blockTimestamp,
        isNeverRebalance(pool),
      );
      // Reassign so the daily-snapshot upsert below freezes the just-updated
      // health counters, not the pre-recordHealthSample values.
      // Recompute `healthStatus`: `recordHealthSample` may have flipped
      // `hasHealthData: false → true` on the first valid sample, and
      // `upsertPool`'s earlier computeHealthStatus ran against the OLD value.
      // Without this, the persisted pool has the new hasHealthData but a
      // stale `N/A` healthStatus (codex P2 PR #370 #3214748736).
      const merged = { ...pool, ...poolUpdate };
      pool = {
        ...merged,
        healthStatus: computeHealthStatus(merged, blockTimestamp),
      };
      context.Pool.set(pool);
      // Skip the OracleSnapshot row when orientation is unknown: we'd be
      // writing a fresh deviation alongside a stale (often zero) oraclePrice
      // because of the orientation gate above. A row whose displayed price
      // doesn't match the deviation is worse than no row — the chart
      // history would show a fake sample. Pool entity still gets updated;
      // the next event with known orientation will write the snapshot.
      if (orientationKnown) {
        const snapshot: OracleSnapshot = {
          id,
          chainId: event.chainId,
          poolId,
          timestamp: blockTimestamp,
          oraclePrice: updateReservesOraclePrice,
          oracleOk: pool.oracleOk,
          numReporters: pool.oracleNumReporters,
          priceDifference: pool.priceDifference,
          degenerateReserves: pool.degenerateReserves,
          // See sortedOracles.OracleReported — `persistableThreshold` gates the
          // 1e12 never-rebalance sentinel out of this `Int!`-typed write.
          rebalanceThreshold: persistableThreshold(pool),
          source: "update_reserves",
          blockNumber,
          txHash: event.transaction.hash,
          // `update_reserves` measures pool-internal post-swap deviation,
          // not oracle deviation — the BreakerBox never evaluates this
          // path. Leave undefined so the chart's per-point breaker verdict
          // falls through to "no band check" for these rows even if a
          // future filter relaxation lets them through.
          breakerBaselineAtSnapshot: undefined,
          breakerThresholdAtSnapshot: undefined,
          ...snapshotFields,
        };
        context.OracleSnapshot.set(snapshot);
      }
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
  },
);

// ---------------------------------------------------------------------------
// FPMM.Rebalanced
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "FPMM", event: "Rebalanced" },
  // eslint-disable-next-line max-lines-per-function -- Existing handler keeps same-event reserve, breach, and rebalance writes together for ordering parity.
  async ({ event, context }) => {
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
          await selfHealTokenDecimals(
            context,
            await selfHealInvertRateFeed(context, initial),
          ),
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
      context.effect(reservesEffect, {
        chainId: event.chainId,
        poolAddress: asAddress(event.srcAddress),
        blockNumber: blockNumber - 1n,
      }),
    );
    const [rebalancingStateRpc, preReserves, blockScopedIncentive] =
      await Promise.all([
        derivedRebalanceState
          ? Promise.resolve(null)
          : context.effect(rebalancingStateEffect, {
              chainId: event.chainId,
              poolAddress: asAddress(event.srcAddress),
              blockNumber,
            }),
        preReservesPromise,
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

    if (resolved) {
      // Health score: compute snapshot fields + update pool accumulators.
      // Note: upsertPool above calls context.Pool.set(pool) internally with
      // default health fields. We immediately overwrite with the correct
      // health accumulators here. Safe because Envio is single-threaded, but
      // the double-write is intentional — health update must come after upsertPool
      // so we have the final pool state to accumulate against.
      const effectiveBps = Number(effectiveThreshold(pool));
      const { snapshotFields, poolUpdate } = recordHealthSample(
        pool,
        pool.priceDifference,
        effectiveBps,
        blockTimestamp,
        isNeverRebalance(pool),
      );
      // Reassign so the daily-snapshot upsert below freezes the just-updated
      // health counters, not the pre-recordHealthSample values.
      // Recompute `healthStatus`: `recordHealthSample` may have flipped
      // `hasHealthData: false → true` on the first valid sample, and
      // `upsertPool`'s earlier computeHealthStatus ran against the OLD value.
      // Without this, the persisted pool has the new hasHealthData but a
      // stale `N/A` healthStatus (codex P2 PR #370 #3214748736).
      const merged = { ...pool, ...poolUpdate };
      pool = {
        ...merged,
        healthStatus: computeHealthStatus(merged, blockTimestamp),
      };
      context.Pool.set(pool);

      // Skip OracleSnapshot when orientation is unknown — see UpdateReserves
      // handler for the rationale (avoid mixing fresh deviation with a
      // stale/preserved oraclePrice in the chart history).
      if (rebalancedOrientationKnown) {
        const snapshot: OracleSnapshot = {
          id,
          chainId: event.chainId,
          poolId,
          timestamp: blockTimestamp,
          oraclePrice: rebalancedOraclePrice,
          oracleOk: pool.oracleOk,
          numReporters: pool.oracleNumReporters,
          priceDifference: pool.priceDifference,
          degenerateReserves: pool.degenerateReserves,
          // See sortedOracles.OracleReported — `persistableThreshold` gates the
          // 1e12 never-rebalance sentinel out of this `Int!`-typed write.
          rebalanceThreshold: persistableThreshold(pool),
          source: "rebalanced",
          blockNumber,
          txHash: event.transaction.hash,
          // `rebalanced` rows measure post-rebalance pool-internal
          // deviation, not oracle deviation — same rationale as
          // `update_reserves`. Leave undefined so the chart's per-point
          // breaker verdict falls through to "no band check".
          breakerBaselineAtSnapshot: undefined,
          breakerThresholdAtSnapshot: undefined,
          ...snapshotFields,
        };
        context.OracleSnapshot.set(snapshot);
      }
    }

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
