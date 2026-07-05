// ---------------------------------------------------------------------------
// upsertPool heal-stage helpers (issue #1056 decomposition)
//
// Named stages of the `upsertPool` pipeline in `src/pool.ts`, in call order:
// fee/feed heal (`healReferenceRateFeed`, `healPoolFees`), breaker-halt
// recompute (`resolveFeedIdAndBreakerHalt`), and the field-merge builder
// (`buildMergedPool`). The three earlier self-heal stages (invert-heal,
// wrapped-exchange link, decimals heal) live in `./self-heal.ts`.
// ---------------------------------------------------------------------------

import type { EffectCaller, Pool } from "envio";
import { UNKNOWN_ORACLE_REPORTERS } from "../constants.js";
import { isVirtualPool } from "../helpers.js";
import {
  compactFees,
  feesEffect,
  referenceRateFeedIDEffect,
  reportExpiryEffect,
} from "../rpc/effects.js";
import { breakerTrippedOnFeedAssign } from "../breakers.js";
import { pickPreferredSource, type PoolUpdateSource } from "./sources.js";
import type { PoolContext } from "./types.js";

/** Default oracle field values (for VirtualPools or when RPC call fails).
 *
 * Excludes static VP oracle config (`referenceRateFeedID`,
 * `oracleFreshnessWindow`) on purpose — those are set ONCE at pool creation
 * or via the BiPoolExchange→Pool mirror. Including them here would mean
 * callers spreading `{...DEFAULT_ORACLE_FIELDS, ...overrides}` as
 * `oracleDelta` could clobber healed values back to defaults via the `next`
 * builder's spread order. `defaultPool` (in `src/pool.ts`) initializes those
 * fields directly; persisted updates flow via the dedicated mirror / heal
 * helpers. */
export const DEFAULT_ORACLE_FIELDS = {
  oracleOk: false,
  oraclePrice: 0n,
  oracleTimestamp: 0n,
  oracleTxHash: "",
  oracleExpiry: 0n,
  oracleNumReporters: UNKNOWN_ORACLE_REPORTERS,
  lastMedianPrice: 0n,
  lastMedianAt: 0n,
  medianLive: true,
  lastOracleReportAt: 0n,
  prevMedianPrice: 0n,
  prevMedianAt: 0n,
  lastOracleJumpBps: "0.0000",
  lastOracleJumpAt: 0n,
  invertRateFeed: false,
  // false = unread (schema default); true = real on-chain value persisted.
  // While false, upsertPool's self-heal retries the effect on every event.
  invertRateFeedKnown: false,
  degenerateReserves: false,
  priceDifference: 0n,
  rebalanceThreshold: 0,
  rebalanceThresholdAbove: 0,
  rebalanceThresholdBelow: 0,
  // Mirrors `invertRateFeedKnown`: false until factory seed or
  // `RebalanceThresholdUpdated` lands real values; gates state-sync self-heal.
  rebalanceThresholdsKnown: false,
  lastRebalancedAt: 0n,
  deviationBreachStartedAt: 0n,
  currentOpenBreachPeak: 0n,
  currentOpenBreachEntryThreshold: 0,
  healthStatus: "N/A" as string,
  limitStatus: "N/A" as string,
  limitPressure0: "0.0000" as string,
  limitPressure1: "0.0000" as string,
  lpFee: -1,
  protocolFee: -1,
  rebalanceReward: -1,
  rebalancerAddress: "" as string,
  rebalanceLivenessStatus: "N/A" as string,
  token0Decimals: 18,
  token1Decimals: 18,
  // Mirrors `invertRateFeedKnown`: false until factory seeds real values
  // (or `selfHealTokenDecimals` lands them); true once persisted. While
  // false, `selfHealTokenDecimals` retries on every event that touches
  // this pool so a deploy-time RPC blip doesn't permanently keep
  // non-18-decimal pools at the schema default 18/18.
  tokenDecimalsKnown: false,
  // Diagnostic only — see schema.graphql comment. NOT a freshness signal.
  lastFreshReporterAt: 0n,
  // Health score accumulators
  healthTotalSeconds: 0n,
  healthBinarySeconds: 0n,
  lastOracleSnapshotTimestamp: 0n,
  lastDeviationRatio: "-1",
  lastEffectivenessRatio: "-1",
  hasHealthData: false,
  cumulativeBreachSeconds: 0n,
  cumulativeCriticalSeconds: 0n,
  breachCount: 0,
};

/** Self-heal `referenceRateFeedID` when it was missed at pool creation
 * (transient RPC failure). Retries via `referenceRateFeedIDEffect`; when a
 * feed resolves, also fetches its current `oracleExpiry` via
 * `reportExpiryEffect`. No-op (both fields `undefined`) for VirtualPools,
 * pools no event has touched yet (`source === ""`), or pools that already
 * carry a feed. `healedFeedId` is returned separately from
 * `healedOracleDelta` because `referenceRateFeedID` is no longer part of
 * `DEFAULT_ORACLE_FIELDS` (extracted to avoid the spread-clobber bug — see
 * the `DEFAULT_ORACLE_FIELDS` doc above); the caller applies it directly in
 * the field-merge stage. */
export async function healReferenceRateFeed(args: {
  context: { effect: EffectCaller };
  existing: Pool;
  chainId: number;
  poolAddr: string;
  blockNumber: bigint;
}): Promise<{
  healedFeedId: string | undefined;
  healedOracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> | undefined;
}> {
  const { context, existing, chainId, poolAddr, blockNumber } = args;
  let healedFeedId: string | undefined;
  let healedOracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> | undefined;
  if (
    existing.referenceRateFeedID === "" &&
    existing.source !== "" &&
    !isVirtualPool(existing)
  ) {
    const rateFeedID = await context.effect(referenceRateFeedIDEffect, {
      chainId,
      poolAddress: poolAddr,
    });
    if (rateFeedID) {
      healedFeedId = rateFeedID;
      const expiry = await context.effect(reportExpiryEffect, {
        chainId,
        rateFeedID,
        blockNumber,
      });
      if (expiry !== null) {
        healedOracleDelta = { oracleExpiry: expiry };
      }
    }
  }
  return { healedFeedId, healedOracleDelta };
}

/** Self-heal `lpFee` / `protocolFee` / `rebalanceReward` when any of them are
 * still at the -1 "not yet attempted" sentinel. Retries now; once a
 * successful read lands — even if the real fee is 0 — the caller persists it
 * and stops retrying. `fetchFees` (behind `feesEffect`) also stamps -2 on any
 * getter that rejects with "returned no data" (contract doesn't implement
 * it), and -2 is excluded from the retry gate so older FPMM deployments
 * missing `rebalanceIncentive()` don't thrash forever. No-op for
 * VirtualPools or pools no event has touched yet. */
export async function healPoolFees(
  context: { effect: EffectCaller },
  existing: Pool,
  chainId: number,
  poolAddr: string,
): Promise<
  | Partial<{ lpFee: number; protocolFee: number; rebalanceReward: number }>
  | undefined
> {
  let healedFees:
    | Partial<{ lpFee: number; protocolFee: number; rebalanceReward: number }>
    | undefined;
  if (
    (existing.lpFee === -1 ||
      existing.protocolFee === -1 ||
      existing.rebalanceReward === -1) &&
    existing.source !== "" &&
    !isVirtualPool(existing)
  ) {
    const fees = await context.effect(feesEffect, {
      chainId,
      poolAddress: poolAddr,
    });
    if (fees) {
      healedFees = compactFees(fees);
    }
  }
  return healedFees;
}

/** Resolve the pool's final `referenceRateFeedID` for this event (caller
 * param > self-heal > existing persisted value) and, when a pool's rate feed
 * is assigned for the first time (the ""→set transition), recompute
 * `breakerTripped` from the feed's current breaker configs — otherwise a
 * pool that first appears while the feed is already halted would read
 * `false` until the next BreakerBox transition. The steady-state gate (only
 * fires on that one transition) lives inside `breakerTrippedOnFeedAssign`. */
export async function resolveFeedIdAndBreakerHalt(args: {
  context: PoolContext;
  chainId: number;
  existing: Pool;
  referenceRateFeedID: string | undefined;
  healedFeedId: string | undefined;
}): Promise<{ finalReferenceRateFeedID: string; breakerTripped: boolean }> {
  const { context, chainId, existing, referenceRateFeedID, healedFeedId } =
    args;
  const finalReferenceRateFeedID =
    referenceRateFeedID ?? healedFeedId ?? existing.referenceRateFeedID;
  const breakerTripped = await breakerTrippedOnFeedAssign(
    context,
    chainId,
    existing,
    finalReferenceRateFeedID,
  );
  return { finalReferenceRateFeedID, breakerTripped };
}

/** Resolve `token0Decimals` / `token1Decimals` / `tokenDecimalsKnown` for the
 * field-merge stage. OR-merges `tokenDecimalsKnown` so a self-healed `true`
 * survives a later caller passing `false` (e.g. a factory replay that
 * blipped). Symmetrically gates the decimal field writes: when the incoming
 * pair is unknown but the existing pair is known, keep the known values.
 * Without this gate, a known-6/18 pool getting a re-blipped factory payload
 * `{18, 18, false}` would clobber the real decimals to 18/18 while the
 * OR-merge held the flag at `true` — locking in wrong scaling. */
function resolveTokenDecimalsFields(
  existing: Pool,
  tokenDecimals:
    | {
        token0Decimals: number;
        token1Decimals: number;
        tokenDecimalsKnown: boolean;
      }
    | undefined,
): {
  token0Decimals: number;
  token1Decimals: number;
  tokenDecimalsKnown: boolean;
} {
  return {
    token0Decimals:
      tokenDecimals && tokenDecimals.tokenDecimalsKnown
        ? tokenDecimals.token0Decimals
        : existing.tokenDecimalsKnown
          ? existing.token0Decimals
          : (tokenDecimals?.token0Decimals ?? existing.token0Decimals),
    token1Decimals:
      tokenDecimals && tokenDecimals.tokenDecimalsKnown
        ? tokenDecimals.token1Decimals
        : existing.tokenDecimalsKnown
          ? existing.token1Decimals
          : (tokenDecimals?.token1Decimals ?? existing.token1Decimals),
    tokenDecimalsKnown:
      tokenDecimals?.tokenDecimalsKnown || existing.tokenDecimalsKnown,
  };
}

/** Merge order for the healed/delta partials applied over `existing`+base
 * fields: healed fields first, then the caller's explicit `oracleDelta`
 * (which wins on overlap), then healed fees. Split out of the `next`
 * builder purely to keep that function's complexity budget clear — no
 * change in merge order or precedence. */
function mergeHealedDeltas(
  healedOracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> | undefined,
  oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> | undefined,
  healedFees:
    | Partial<{ lpFee: number; protocolFee: number; rebalanceReward: number }>
    | undefined,
): Partial<Pool> {
  return {
    ...(healedOracleDelta ?? {}),
    ...(oracleDelta ?? {}),
    ...(healedFees ?? {}),
  };
}

/** `createdAtBlock`/`createdAtTimestamp` are stamped once on first touch
 * (existing value at the schema-default `0n` sentinel) and preserved on
 * every subsequent event. */
function nextCreatedAt(
  existing: Pool,
  blockNumber: bigint,
  blockTimestamp: bigint,
): { createdAtBlock: bigint; createdAtTimestamp: bigint } {
  return {
    createdAtBlock:
      existing.createdAtBlock === 0n ? blockNumber : existing.createdAtBlock,
    createdAtTimestamp:
      existing.createdAtTimestamp === 0n
        ? blockTimestamp
        : existing.createdAtTimestamp,
  };
}

/** Field-merge stage: builds the next Pool row from `existing` plus every
 * heal/delta input gathered by the earlier stages. Merge order is
 * significant and preserved exactly from the prior inline implementation:
 * healed fields first, then the caller's explicit `oracleDelta` (which wins
 * on overlap), then `referenceRateFeedID`/`breakerTripped` applied AFTER the
 * spread chain so an `oracleDelta` that omits the field can't clobber it. */
export function buildMergedPool(args: {
  existing: Pool;
  chainId: number;
  token0: string | undefined;
  token1: string | undefined;
  source: PoolUpdateSource;
  reservesDelta: { reserve0: bigint; reserve1: bigint } | undefined;
  swapDelta: { volume0: bigint; volume1: bigint } | undefined;
  rebalanceDelta: boolean | undefined;
  healedOracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> | undefined;
  oracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> | undefined;
  healedFees:
    | Partial<{ lpFee: number; protocolFee: number; rebalanceReward: number }>
    | undefined;
  finalReferenceRateFeedID: string;
  breakerTripped: boolean;
  tokenDecimals:
    | {
        token0Decimals: number;
        token1Decimals: number;
        tokenDecimalsKnown: boolean;
      }
    | undefined;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Pool {
  const {
    existing,
    chainId,
    token0,
    token1,
    source,
    reservesDelta,
    swapDelta,
    rebalanceDelta,
    healedOracleDelta,
    oracleDelta,
    healedFees,
    finalReferenceRateFeedID,
    breakerTripped,
    tokenDecimals,
    blockNumber,
    blockTimestamp,
  } = args;
  return {
    ...existing,
    chainId,
    token0: token0 ?? existing.token0,
    token1: token1 ?? existing.token1,
    source: pickPreferredSource(existing.source, source),
    reserves0: reservesDelta?.reserve0 ?? existing.reserves0,
    reserves1: reservesDelta?.reserve1 ?? existing.reserves1,
    swapCount: existing.swapCount + (swapDelta ? 1 : 0),
    notionalVolume0: existing.notionalVolume0 + (swapDelta?.volume0 ?? 0n),
    notionalVolume1: existing.notionalVolume1 + (swapDelta?.volume1 ?? 0n),
    rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
    // Merge healed fields first, then explicit delta takes precedence
    ...mergeHealedDeltas(healedOracleDelta, oracleDelta, healedFees),
    // `referenceRateFeedID` is applied AFTER the spread chain so the
    // value isn't clobbered by an oracleDelta that omits it (the field
    // is no longer in DEFAULT_ORACLE_FIELDS — callers can't include it
    // in the spread). Priority: caller-supplied param (FPMM factory) >
    // self-heal > existing.
    referenceRateFeedID: finalReferenceRateFeedID,
    breakerTripped,
    ...resolveTokenDecimalsFields(existing, tokenDecimals),
    // `wrappedExchangeId` is owned by `selfHealWrappedExchangeId`, called by
    // the `upsertPool` orchestrator before this stage. The helper returns a
    // new object on heal, the original on no-op, so the spread carries the
    // field through without `buildMergedPool` needing to touch it.
    ...nextCreatedAt(existing, blockNumber, blockTimestamp),
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };
}
