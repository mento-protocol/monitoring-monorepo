// ---------------------------------------------------------------------------
// FPMM state-sync effect reader: rows 1-4 of
// docs/PLAN-indexer-preload-state-sync.md. Each effect has one key builder
// (row 3's lives in `oracle-recovery.ts`), so preload and processing request
// identical inputs and Envio reuses the preload result.
// ---------------------------------------------------------------------------

import type { EvmOnEventContext, Pool } from "envio";
import { asAddress, asBigInt } from "../../helpers.js";
import {
  scaleRpcRebalanceState,
  tryDeriveRebalanceState,
  type ResolvedRebalanceState,
} from "../../priceDifference.js";
import {
  medianTimestampEffectForChain,
  rebalanceIncentiveAtBlockEffect,
  rebalancingStateEffect,
} from "../../rpc/effects.js";
import { resolveReferenceRateFeedForOracleRead } from "./oracle-recovery.js";

type AuthoritativeRebalanceState = {
  medianTimestamp: bigint | null;
  oracleFreshnessProven: boolean;
  resolved: ResolvedRebalanceState | null;
};

async function fetchAuthoritativeRebalanceState(args: {
  blockNumber: bigint;
  chainId: number;
  context: EvmOnEventContext;
  existing: Pool | undefined;
  poolAddress: string;
}): Promise<AuthoritativeRebalanceState> {
  const rateFeedID = await resolveReferenceRateFeedForOracleRead({
    chainId: args.chainId,
    context: args.context,
    existingFeedId: args.existing?.referenceRateFeedID ?? "",
    poolAddress: args.poolAddress,
  });
  const [rpc, medianTimestamp] = await Promise.all([
    args.context.effect(
      rebalancingStateEffect,
      rebalancingStateKey(args.chainId, args.poolAddress, args.blockNumber),
    ),
    rateFeedID
      ? args.context.effect(
          medianTimestampEffectForChain(args.chainId),
          medianTimestampKey(args.chainId, rateFeedID, args.blockNumber),
        )
      : Promise.resolve(null),
  ]);
  const exactMedianTimestamp =
    rpc && medianTimestamp !== null && medianTimestamp > 0n
      ? medianTimestamp
      : null;
  return {
    medianTimestamp: exactMedianTimestamp,
    oracleFreshnessProven: exactMedianTimestamp !== null,
    resolved: rpc ? scaleRpcRebalanceState(rpc, args.existing) : null,
  };
}

async function resolveRebalanceState(args: {
  blockNumber: bigint;
  chainId: number;
  context: EvmOnEventContext;
  derived: ResolvedRebalanceState | null;
  existing: Pool | undefined;
  poolAddress: string;
}): Promise<AuthoritativeRebalanceState> {
  if (args.derived) {
    return {
      medianTimestamp: null,
      oracleFreshnessProven: false,
      resolved: args.derived,
    };
  }
  return fetchAuthoritativeRebalanceState(args);
}

// ---------------------------------------------------------------------------
// Preload-safe effect reader: rows 1-4 of
// docs/PLAN-indexer-preload-state-sync.md. Each effect has one key builder
// (row 3's lives in `oracle-recovery.ts`), so preload and processing request
// identical inputs and Envio reuses the preload result.
// ---------------------------------------------------------------------------

function rebalancingStateKey(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
) {
  return { chainId, poolAddress, blockNumber };
}

function medianTimestampKey(
  chainId: number,
  rateFeedID: string,
  blockNumber: bigint,
) {
  return { chainId, rateFeedID, blockNumber };
}

function rebalanceIncentiveKey(
  chainId: number,
  poolAddress: string,
  blockNumber: bigint,
) {
  return { chainId, poolAddress, blockNumber };
}

type StateSyncEvent = {
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: string; from?: string | undefined };
};

export type UpdateReservesEvent = StateSyncEvent & {
  params: { reserve0: bigint; reserve1: bigint; blockTimestamp: bigint };
};

export type RebalancedEvent = StateSyncEvent & {
  params: {
    sender: string;
    priceDifferenceBefore: bigint;
    priceDifferenceAfter: bigint;
  };
};

type StateSyncEffects = {
  authoritative: AuthoritativeRebalanceState;
  /** Row 4, `Rebalanced` only: `-2` when the getter is known missing, `null`
   * on RPC failure and for `UpdateReserves`. */
  blockScopedIncentive: number | null;
};

/** Request rows 1-4 for one state-sync event, gated on the caller's own Pool
 * read. Preload passes its preload Pool; processing passes the ordered,
 * self-healed Pool and so derives every gate again. It writes no entity. */
export async function readStateSyncEffects(
  context: EvmOnEventContext,
  event: UpdateReservesEvent | RebalancedEvent,
  pool: Pool | undefined,
): Promise<StateSyncEffects> {
  const chainId = event.chainId;
  const poolAddress = asAddress(event.srcAddress);
  const blockNumber = asBigInt(event.block.number);
  const eventTimestamp = asBigInt(event.block.timestamp);
  // UpdateReserves: `getRebalancingState` reads post-event state on chain,
  // but `pool.reserves0/1` still hold the prior value until `upsertPool`.
  const isUpdateReserves = "reserve0" in event.params;
  const derived = !pool
    ? null
    : "reserve0" in event.params
      ? tryDeriveRebalanceState(pool, {
          eventTimestamp,
          reservesOverride: {
            reserve0: event.params.reserve0,
            reserve1: event.params.reserve1,
          },
        })
      : tryDeriveRebalanceState(pool, { eventTimestamp });
  const [authoritative, blockScopedIncentive] = await Promise.all([
    resolveRebalanceState({
      blockNumber,
      chainId,
      context,
      derived,
      existing: pool,
      poolAddress,
    }),
    // Read the reward in force at the event block: `Pool.rebalanceReward`
    // may carry today's value during a resync. The `-2` sentinel (getter
    // absent) skips a read that cannot succeed.
    isUpdateReserves
      ? Promise.resolve(null)
      : pool?.rebalanceReward === -2
        ? Promise.resolve(-2)
        : context.effect(
            rebalanceIncentiveAtBlockEffect,
            rebalanceIncentiveKey(chainId, poolAddress, blockNumber),
          ),
  ]);
  return { authoritative, blockScopedIncentive };
}
