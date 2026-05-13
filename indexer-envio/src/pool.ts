// ---------------------------------------------------------------------------
// Pool upsert logic and public pool-module re-exports
// ---------------------------------------------------------------------------

import type { Pool } from "envio";
import { extractAddressFromPoolId, isVirtualPool } from "./helpers.js";
import { computePriceDifference } from "./priceDifference.js";
import {
  compactFees,
  feesEffect,
  referenceRateFeedIDEffect,
  reportExpiryEffect,
} from "./rpc/effects.js";
import { recordBreachTransition } from "./deviationBreach.js";
import {
  computeHealthStatus,
  isNeverRebalance,
  nextDeviationBreachStartedAt,
  nextOpenBreachEntryThreshold,
  nextOpenBreachPeak,
} from "./pool/health.js";
import { pickPreferredSource, type PoolUpdateSource } from "./pool/sources.js";
import {
  selfHealInvertRateFeed,
  selfHealTokenDecimals,
  selfHealWrappedExchangeId,
} from "./pool/self-heal.js";
import type { PoolContext } from "./pool/types.js";

export {
  DEVIATION_BREACH_GRACE_SECONDS,
  DEVIATION_CRITICAL_DEN,
  DEVIATION_CRITICAL_NUM,
  DEVIATION_TOLERANCE_DEN,
  DEVIATION_TOLERANCE_NUM,
  breachEntryThreshold,
  computeHealthStatus,
  effectiveThreshold,
  isAboveCriticalMagnitude,
  isInDeviationBreach,
  isNeverRebalance,
  nextDeviationBreachStartedAt,
  nextOpenBreachEntryThreshold,
  nextOpenBreachPeak,
  persistableThreshold,
} from "./pool/health.js";
export type { IndexerHealthStatus } from "./pool/health.js";
export type { PoolUpdateSource } from "./pool/sources.js";
export {
  mirrorFeedIdToPool,
  mirrorTokensAndDecimalsToPool,
  selfHealInvertRateFeed,
  selfHealRebalanceThresholds,
  selfHealTokenDecimals,
  selfHealWrappedExchangeId,
} from "./pool/self-heal.js";
export type { PoolContext, SnapshotContext } from "./pool/types.js";
export { upsertDailySnapshot, upsertSnapshot } from "./pool/snapshots.js";

// ---------------------------------------------------------------------------
// Pool upsert (with cumulative fields)
// ---------------------------------------------------------------------------

/**
 * Preload-phase helper used by every event handler that makes direct RPC
 * calls. Returns `true` when we're in the preload pass and the caller
 * should `return` early (after awaiting this). Returns `false` during
 * the processing pass so the caller continues with its full body.
 *
 * Seeds BOTH the Pool entity cache AND the currently-open breach row
 * (when one exists) during preload. Skipping the breach-row warm-up
 * costs measurable extra sync time because `recordBreachTransition`
 * hits `DeviationThresholdBreach.get` in the processing phase — that
 * read goes cold otherwise.
 */
export async function maybePreloadPool(
  context: {
    isPreload: boolean;
    Pool: { get: (id: string) => Promise<Pool | undefined> };
    DeviationThresholdBreach: {
      get: (id: string) => Promise<unknown>;
    };
  },
  poolIds: string | readonly string[],
): Promise<boolean> {
  if (!context.isPreload) return false;
  const ids = typeof poolIds === "string" ? [poolIds] : poolIds;
  await Promise.all(
    ids.map(async (id) => {
      const pool = await context.Pool.get(id);
      if (pool && pool.deviationBreachStartedAt > 0n) {
        await context.DeviationThresholdBreach.get(
          `${id}-${pool.deviationBreachStartedAt}`,
        );
      }
    }),
  );
  return true;
}

/** Default oracle field values (for VirtualPools or when RPC call fails).
 *
 * Excludes `referenceRateFeedID` on purpose — that's a static-config field
 * set ONCE at pool creation (factory `referenceRateFeedIDEffect`) or via
 * the BiPoolExchange→Pool mirror (`mirrorFeedIdToPool`). Including it here
 * would mean callers spreading `{...DEFAULT_ORACLE_FIELDS, ...overrides}`
 * as `oracleDelta` would clobber a healed feedID back to "" via the
 * `next` builder's spread order. `defaultPool` initializes the field
 * directly below; persisted updates flow via the dedicated mirror /
 * heal helpers. */
export const DEFAULT_ORACLE_FIELDS = {
  oracleOk: false,
  oraclePrice: 0n,
  oracleTimestamp: 0n,
  oracleTxHash: "",
  oracleExpiry: 0n,
  oracleNumReporters: 0,
  lastMedianPrice: 0n,
  lastMedianAt: 0n,
  medianLive: false,
  lastOracleReportAt: 0n,
  prevMedianPrice: 0n,
  prevMedianAt: 0n,
  lastOracleJumpBps: "0.0000",
  lastOracleJumpAt: 0n,
  invertRateFeed: false,
  // false = unread (schema default); true = real on-chain value persisted.
  // While false, upsertPool's self-heal retries the effect on every event.
  invertRateFeedKnown: false,
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

const getOrCreatePool = async (
  context: PoolContext,
  chainId: number,
  poolId: string,
  defaults?: { token0?: string; token1?: string },
): Promise<Pool> => {
  const existing = await context.Pool.get(poolId);
  return existing ?? defaultPool(chainId, poolId, defaults);
};

const defaultPool = (
  chainId: number,
  poolId: string,
  defaults?: { token0?: string; token1?: string },
): Pool => ({
  id: poolId,
  chainId,
  token0: defaults?.token0,
  token1: defaults?.token1,
  source: "",
  reserves0: 0n,
  reserves1: 0n,
  swapCount: 0,
  notionalVolume0: 0n,
  notionalVolume1: 0n,
  rebalanceCount: 0,
  ...DEFAULT_ORACLE_FIELDS,
  // Static-config fields excluded from DEFAULT_ORACLE_FIELDS to avoid
  // the spread-clobber bug — callers' `oracleDelta` must NOT carry the
  // power to overwrite these on every event.
  referenceRateFeedID: "",
  // Populated by `selfHealWrappedExchangeId` on first VP-event upsert
  // (factory-direct value or bytecode read). Empty for FPMMs.
  wrappedExchangeId: "",
  createdAtBlock: 0n,
  createdAtTimestamp: 0n,
  updatedAtBlock: 0n,
  updatedAtTimestamp: 0n,
});

export const upsertPool = async ({
  context,
  chainId,
  poolId,
  token0,
  token1,
  source,
  blockNumber,
  blockTimestamp,
  txHash,
  strategy,
  reservesDelta,
  swapDelta,
  rebalanceDelta,
  oracleDelta,
  tokenDecimals,
  referenceRateFeedID,
  existing: existingOverride,
}: {
  context: PoolContext;
  chainId: number;
  poolId: string;
  token0?: string;
  token1?: string;
  source: PoolUpdateSource;
  blockNumber: bigint;
  blockTimestamp: bigint;
  /** Transaction hash of the event driving this upsert. Required —
   * breach-transition rows store it as `startedByTxHash` / `endedByTxHash`.
   * All handler callers have `event.transaction.hash` available. */
  txHash: string;
  /** Rebalancer strategy contract that fired the event. Only read when
   * source === "fpmm_rebalanced" — populates `endedByStrategy` on a breach
   * the rebalance closes. */
  strategy?: string;
  reservesDelta?: { reserve0: bigint; reserve1: bigint };
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  oracleDelta?: Partial<typeof DEFAULT_ORACLE_FIELDS>;
  tokenDecimals?: {
    token0Decimals: number;
    token1Decimals: number;
    tokenDecimalsKnown: boolean;
  };
  /** Static-config field for the referenced rate feed; explicit param so
   * callers can't accidentally clobber it via `oracleDelta` spread (see
   * the doc on `DEFAULT_ORACLE_FIELDS`). Only the FPMM factory + the
   * BiPoolExchange→Pool mirror set it; all other callers pass undefined
   * and the persisted value flows through unchanged. */
  referenceRateFeedID?: string;
  /** Caller-provided pool snapshot. Handlers that have already done
   * `context.Pool.get(poolId)` (e.g. FPMM UR/Rebalanced, which fetch it
   * concurrently with RPC) should pass the result here — wrapped as
   * `{ pool: ... }` so `pool: undefined` (fresh pool) is distinguishable
   * from "not passed". When `undefined`, upsertPool does its own lookup. */
  existing?: { pool: Pool | undefined };
}): Promise<Pool> => {
  const initialBase = existingOverride
    ? (existingOverride.pool ??
      defaultPool(chainId, poolId, { token0, token1 }))
    : await getOrCreatePool(context, chainId, poolId, { token0, token1 });
  // Carry the caller's intended source into the heal pipeline ONLY when
  // the persisted source is the empty defaultPool sentinel — otherwise
  // the unconditional override defeats `pickPreferredSource` below by
  // making `existing.source === source` regardless of priority. The
  // VP/FPMM-aware gates (`isVirtualPool`, `pool.source === ""`) need the
  // first-touch source-fill, but later events on a pool with an already-
  // ranked source must keep the persisted value through this stage.
  const existingInitial: Pool = initialBase.source
    ? initialBase
    : { ...initialBase, source };
  // Heal pipeline: invertRateFeed → wrappedExchangeId (VP only) →
  // tokenDecimals. Each helper short-circuits when its field is already
  // healed, so the per-event cost is at most a few boolean checks once
  // a pool is fully seeded. All three back-end effects are `cache: true`
  // (per-pool-once across the run).
  const invertHealed = await selfHealInvertRateFeed(context, existingInitial);
  // Self-heal `wrappedExchangeId` using `vpExchangeIdEffect` (bytecode-
  // pattern detector) as the authoritative VP test. The previous source-
  // based gate (`isVirtualPool(pool)` checks `pool.source.includes("virtual")`)
  // missed pre-start_block VPs whose first observed event is `VirtualPool.Swap`
  // / `Mint` / `Burn` — those handlers reuse the `fpmm_*` source keys
  // (intentional: they share priority with FPMM events for `pickPreferredSource`),
  // so the pool source never gets the "virtual" substring → self-heal was
  // skipped → `wrappedExchangeId` never populated. Bytecode is immutable
  // and the effect is `cache: true`. `vpExchangeIdEffect` discriminates
  // "got bytecode, not a VP" (cached as a permanent miss → FPMM hot path
  // pays one RPC per address total) from "RPC threw" (transient, NOT
  // cached → next event for that address retries). See
  // `vpExchangeIdEffect` in `src/rpc/effects.ts` for the discriminator.
  // Call site delegates fully to `selfHealWrappedExchangeId` — that
  // function's internal gate decides whether to short-circuit. We
  // can't gate at the call site on `wrappedExchangeId && token0 &&
  // token1` because that would skip the seed-retry path the helper
  // owns (round 7 codex #3: a `VirtualPoolDeployed` whose seed RPC
  // fails sets all three fields but leaves `BiPoolExchange` unseeded).
  // `vpExchangeIdEffect` is `cache:true`, so the helper's bytecode
  // probe is free on re-entry; the only added work for fully-healed
  // pools is one DB read for `BiPoolExchange.get`.
  const wrappedHealed = await selfHealWrappedExchangeId(
    context,
    invertHealed,
    blockNumber,
    blockTimestamp,
  );
  // tokenDecimals heal short-circuits for VPs (the helper checks
  // `isVirtualPool`) so FPMM-only paths pay the cost.
  const existing = await selfHealTokenDecimals(context, wrappedHealed);

  // Self-heal: if referenceRateFeedID is missing (transient RPC failure at
  // pool creation), retry now so oracle events can start flowing.
  // Use the raw address (not the namespaced poolId) for RPC calls.
  const poolAddr = extractAddressFromPoolId(poolId);
  // `healedFeedId` is split from `healedOracleDelta` because
  // `referenceRateFeedID` is no longer part of `DEFAULT_ORACLE_FIELDS`
  // (extracted to avoid the spread-clobber bug — see DEFAULT_ORACLE_FIELDS
  // doc above). Applied directly in the `next` builder below.
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

  // (invertRateFeed self-heal already happened above via
  // `selfHealInvertRateFeed(context, existingInitial)` — its result is in
  // `existing` and flows through the `...existing` spread into `next`.)

  // Self-heal: if fees are still at the -1 "not yet attempted" sentinel,
  // retry now. Once we get a successful read — even if the real fees are
  // 0 — we persist the result and stop retrying. fetchFees also stamps
  // -2 on any getter that rejects with "returned no data" (contract
  // doesn't implement it), and -2 is excluded here so we don't thrash
  // forever on older FPMM deployments missing rebalanceIncentive().
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

  let next: Pool = {
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
    ...(healedOracleDelta ?? {}),
    ...(oracleDelta ?? {}),
    ...(healedFees ?? {}),
    // `referenceRateFeedID` is applied AFTER the spread chain so the
    // value isn't clobbered by an oracleDelta that omits it (the field
    // is no longer in DEFAULT_ORACLE_FIELDS — callers can't include it
    // in the spread). Priority: caller-supplied param (FPMM factory) >
    // self-heal > existing.
    referenceRateFeedID:
      referenceRateFeedID ?? healedFeedId ?? existing.referenceRateFeedID,
    // OR-merge `tokenDecimalsKnown` so a self-healed `true` survives a
    // later caller passing `false` (e.g. a factory replay that blipped).
    // Symmetrically, gate the decimal field writes: when the incoming pair
    // is unknown but the existing pair is known, keep the known values.
    // Without this gate, a known-6/18 pool getting a re-blipped factory
    // payload `{18, 18, false}` would clobber the real decimals to 18/18
    // while the OR-merge held the flag at `true` — locking in wrong scaling.
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
    // `wrappedExchangeId` is owned by `selfHealWrappedExchangeId` above —
    // the helper updates `existing` in place (returns a new object on
    // healing, original on no-op) so the spread carries the field through.
    createdAtBlock:
      existing.createdAtBlock === 0n ? blockNumber : existing.createdAtBlock,
    createdAtTimestamp:
      existing.createdAtTimestamp === 0n
        ? blockTimestamp
        : existing.createdAtTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };

  // Use contract-provided priceDifference when available (passed via oracleDelta
  // from fetchRebalancingState). Only fall back to local recomputation when the
  // contract value was not supplied (e.g. oracle-only update events).
  // `tokenDecimalsKnown=false` blocks the local recomputation: `normalizeTo18`
  // would silently use the schema-default 18/18 and produce a priceDifference
  // off by 10^(18 - real_dec) for non-18-decimal pools whose factory +
  // self-heal both blipped. Preserve `existing.priceDifference` until
  // self-heal lands real decimals.
  const hasContractPriceDiff =
    oracleDelta != null &&
    "priceDifference" in oracleDelta &&
    oracleDelta.priceDifference !== undefined;
  const canRecompute =
    !isVirtualPool(next) && next.oraclePrice > 0n && next.tokenDecimalsKnown;
  const priceDifference = hasContractPriceDiff
    ? oracleDelta.priceDifference!
    : canRecompute
      ? computePriceDifference(next)
      : next.priceDifference;

  // When priceDifference is frozen (no contract-provided value AND can't
  // recompute), skip the breach pipeline entirely. Feeding the frozen
  // value into `nextDeviationBreachStartedAt` / `recordBreachTransition`
  // would let a same-block threshold update flip breach state from
  // stale/default deviation data — corrupting `DeviationThresholdBreach`
  // rows. VirtualPools always take this branch (canRecompute=false for
  // them) but their breach state stays at default-zero anyway, so the
  // skip is a no-op for them. Mirrors the SortedOracles handler guard.
  //
  // EXCEPTION: when the new state is `isNeverRebalance` (governance just
  // disabled rebalancing), let the breach pipeline run anyway —
  // `isInDeviationBreach` short-circuits to false via `isNeverRebalance`,
  // which lets `recordBreachTransition` close any open DTB row regardless
  // of the frozen priceDifference. Without this exception, the
  // limits-and-fees known-zero fallback's `upsertPool` routing would
  // never close the breach (it relied on the breach pipeline to close it
  // via the falling-edge logic).
  const priceDifferenceTrustworthy = hasContractPriceDiff || canRecompute;
  const becameNeverRebalance = isNeverRebalance(next);
  if (!priceDifferenceTrustworthy && !becameNeverRebalance) {
    const persistedNoBreach: Pool = { ...next, priceDifference };
    context.Pool.set(persistedNoBreach);
    return persistedNoBreach;
  }

  const withDeviation = { ...next, priceDifference };
  // Compute breach-start BEFORE health, so computeHealthStatus reads the
  // current row's anchor (grace window is keyed on it). Reversing the order
  // would ask health about the stale (prior-event) breach start.
  const deviationBreachStartedAt = nextDeviationBreachStartedAt(
    existing,
    withDeviation,
    blockTimestamp,
    source,
  );
  const provisional = { ...withDeviation, deviationBreachStartedAt };
  const currentOpenBreachPeak = nextOpenBreachPeak(existing, provisional);
  const currentOpenBreachEntryThreshold = nextOpenBreachEntryThreshold(
    existing,
    provisional,
  );
  const withBreach = {
    ...provisional,
    currentOpenBreachPeak,
    currentOpenBreachEntryThreshold,
  };
  const healthStatus = computeHealthStatus(withBreach, blockTimestamp);

  // Maintain the per-breach history entity + roll closed-breach durations
  // into the Pool's cumulative counters. Runs against existing → withBreach
  // so the transition detector sees pre/post states on the same basis as
  // `nextDeviationBreachStartedAt`.
  const breachPoolUpdate = await recordBreachTransition(
    context,
    existing.source === "" ? undefined : existing, // brand-new pool → no prev
    { ...withBreach, healthStatus },
    { blockTimestamp, blockNumber, txHash, source, strategy },
  );

  const final: Pool = {
    ...withBreach,
    healthStatus,
    ...breachPoolUpdate,
  };

  context.Pool.set(final);
  return final;
};
