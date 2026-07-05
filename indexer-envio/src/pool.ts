// ---------------------------------------------------------------------------
// Pool upsert logic and public pool-module re-exports
// ---------------------------------------------------------------------------

import type { Pool } from "envio";
import { extractAddressFromPoolId, isVirtualPool } from "./helpers.js";
import {
  classifyExactZeroReserves,
  computePriceDifference,
  hasDegenerateReserves,
} from "./priceDifference.js";
import { recordBreachTransition } from "./deviationBreach.js";
import {
  computeHealthStatus,
  isNeverRebalance,
  nextDeviationBreachStartedAt,
  nextOpenBreachEntryThreshold,
  nextOpenBreachPeak,
} from "./pool/health.js";
import type { PoolUpdateSource } from "./pool/sources.js";
import {
  selfHealInvertRateFeed,
  selfHealTokenDecimals,
  selfHealWrappedExchangeId,
} from "./pool/self-heal.js";
import {
  DEFAULT_ORACLE_FIELDS,
  buildMergedPool,
  healPoolFees,
  healReferenceRateFeed,
  resolveFeedIdAndBreakerHalt,
} from "./pool/upsert-stages.js";
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
  mirrorVirtualPoolOracleConfig,
  mirrorTokensAndDecimalsToPool,
  selfHealInvertRateFeed,
  selfHealRebalanceThresholds,
  selfHealTokenDecimals,
  selfHealWrappedExchangeId,
} from "./pool/self-heal.js";
export type { PoolContext, SnapshotContext } from "./pool/types.js";
export { DEFAULT_ORACLE_FIELDS } from "./pool/upsert-stages.js";
export { upsertDailySnapshot, upsertSnapshot } from "./pool/snapshots.js";

// ---------------------------------------------------------------------------
// Pool upsert (with cumulative fields)
// ---------------------------------------------------------------------------

/**
 * Preload-phase helper used by handlers that warm Pool reads before returning
 * from Envio's preload pass. `maybePreloadPool` returns `true` when the caller
 * should return early; `preloadPoolCache` exposes the warmed Pool row to
 * callers that need to issue dependent `context.effect(...)` reads first. Its
 * own `isPreload` guard makes it safe to call from either pass.
 *
 * Seeds BOTH the Pool entity cache AND the currently-open breach row
 * (when one exists) during preload. Skipping the breach-row warm-up
 * costs measurable extra sync time because `recordBreachTransition`
 * hits `DeviationThresholdBreach.get` in the processing phase — that
 * read goes cold otherwise.
 */
type PreloadPoolContext = {
  isPreload: boolean;
  Pool: { get: (id: string) => Promise<Pool | undefined> };
  DeviationThresholdBreach: {
    get: (id: string) => Promise<unknown>;
  };
};

async function preloadPoolAndOpenBreach(
  context: PreloadPoolContext,
  id: string,
): Promise<Pool | undefined> {
  const pool = await context.Pool.get(id);
  if (pool && pool.deviationBreachStartedAt > 0n) {
    await context.DeviationThresholdBreach.get(
      `${id}-${pool.deviationBreachStartedAt}`,
    );
  }
  return pool;
}

export async function preloadPoolCache(
  context: PreloadPoolContext,
  poolId: string,
): Promise<Pool | undefined> {
  if (!context.isPreload) return undefined;
  return preloadPoolAndOpenBreach(context, poolId);
}

export async function maybePreloadPool(
  context: PreloadPoolContext,
  poolIds: string | readonly string[],
): Promise<boolean> {
  if (!context.isPreload) return false;
  const ids = typeof poolIds === "string" ? [poolIds] : poolIds;
  await Promise.all(ids.map((id) => preloadPoolAndOpenBreach(context, id)));
  return true;
}

type OracleDelta = Partial<typeof DEFAULT_ORACLE_FIELDS>;

function nextDegenerateReserveState(
  next: Pool,
  oracleDelta: OracleDelta | undefined,
  canClassifyDegenerateReserves: boolean,
): boolean {
  if (oracleDelta?.degenerateReserves !== undefined)
    return oracleDelta.degenerateReserves;
  const exactZeroState = classifyExactZeroReserves(next);
  if (exactZeroState !== undefined) return exactZeroState;
  return canClassifyDegenerateReserves
    ? hasDegenerateReserves(next)
    : next.degenerateReserves;
}

function canClassifyDegenerateReserveState(pool: Pool): boolean {
  return !isVirtualPool(pool) && pool.tokenDecimalsKnown;
}

const getOrCreatePool = async (
  context: PoolContext,
  chainId: number,
  poolId: string,
  defaults?: { token0?: string | undefined; token1?: string | undefined },
): Promise<Pool> => {
  const existing = await context.Pool.get(poolId);
  return existing ?? defaultPool(chainId, poolId, defaults);
};

const defaultPool = (
  chainId: number,
  poolId: string,
  defaults?: { token0?: string | undefined; token1?: string | undefined },
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
  oracleFreshnessWindow: 0n,
  // Excluded from DEFAULT_ORACLE_FIELDS for the same spread-clobber reason:
  // `syncPoolsBreakerHalt` writes this directly off BreakerBox events, so an
  // `oracleDelta` spread must never reset it.
  breakerTripped: false,
  // Populated by `selfHealWrappedExchangeId` on first VP-event upsert
  // (factory-direct value or bytecode read). Empty for FPMMs.
  wrappedExchangeId: "",
  createdAtBlock: 0n,
  createdAtTimestamp: 0n,
  updatedAtBlock: 0n,
  updatedAtTimestamp: 0n,
});

// eslint-disable-next-line max-lines-per-function -- Existing pool upsert pipeline remains intentionally centralized for atomic state updates.
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
  logIndex,
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
  token0?: string | undefined;
  token1?: string | undefined;
  source: PoolUpdateSource;
  blockNumber: bigint;
  blockTimestamp: bigint;
  logIndex?: number | undefined;
  /** Transaction hash stored on breach rows as startedBy/endedBy tx hash. */
  txHash: string;
  /** Rebalancer strategy contract that fired the event. Only read when
   * source === "fpmm_rebalanced" — populates `endedByStrategy` on a breach
   * the rebalance closes. */
  strategy?: string | undefined;
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
  referenceRateFeedID?: string | undefined;
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

  // Use the raw address (not the namespaced poolId) for RPC calls.
  const poolAddr = extractAddressFromPoolId(poolId);
  // (invertRateFeed self-heal already happened above via
  // `selfHealInvertRateFeed(context, existingInitial)` — its result is in
  // `existing` and flows through the `...existing` spread into `next`.)
  const { healedFeedId, healedOracleDelta } = await healReferenceRateFeed({
    context,
    existing,
    chainId,
    poolAddr,
    blockNumber,
  });
  const healedFees = await healPoolFees(context, existing, chainId, poolAddr);

  const { finalReferenceRateFeedID, breakerTripped } =
    await resolveFeedIdAndBreakerHalt({
      context,
      chainId,
      existing,
      referenceRateFeedID,
      healedFeedId,
    });

  const next: Pool = buildMergedPool({
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
  });

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
  const canClassifyDegenerateReserves = canClassifyDegenerateReserveState(next);
  const priceDifference = hasContractPriceDiff
    ? oracleDelta.priceDifference!
    : canRecompute
      ? computePriceDifference(next)
      : next.priceDifference;
  const degenerateReserves = nextDegenerateReserveState(
    next,
    oracleDelta,
    canClassifyDegenerateReserves,
  );

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
  //
  // EXCEPTION: when reserves become degenerate while an anchor is already
  // open, run the pipeline even with a frozen priceDifference. The degenerate
  // early-exit in `nextDeviationBreachStartedAt` is the evidence needed to
  // close the breach immediately.
  const priceDifferenceTrustworthy = hasContractPriceDiff || canRecompute;
  const becameNeverRebalance = isNeverRebalance(next);
  const shouldCloseDegenerateBreach =
    degenerateReserves && existing.deviationBreachStartedAt > 0n;
  if (
    shouldSkipFrozenPriceBreachPipeline({
      priceDifferenceTrustworthy,
      becameNeverRebalance,
      shouldCloseDegenerateBreach,
    })
  ) {
    const persistedNoBreach: Pool = {
      ...next,
      priceDifference,
      degenerateReserves,
    };
    context.Pool.set(persistedNoBreach);
    return persistedNoBreach;
  }

  const withDeviation = { ...next, priceDifference, degenerateReserves };
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

  // Maintain breach history and roll closed durations into Pool counters.
  const breachPoolUpdate = await recordBreachTransition(
    context,
    existing.source === "" ? undefined : existing, // brand-new pool → no prev
    { ...withBreach, healthStatus },
    strategy === undefined
      ? { blockTimestamp, blockNumber, txHash, logIndex, source }
      : { blockTimestamp, blockNumber, txHash, logIndex, source, strategy },
  );

  const final: Pool = {
    ...withBreach,
    healthStatus,
    ...breachPoolUpdate,
  };

  context.Pool.set(final);
  return final;
};

function shouldSkipFrozenPriceBreachPipeline({
  priceDifferenceTrustworthy,
  becameNeverRebalance,
  shouldCloseDegenerateBreach,
}: {
  priceDifferenceTrustworthy: boolean;
  becameNeverRebalance: boolean;
  shouldCloseDegenerateBreach: boolean;
}): boolean {
  return (
    !priceDifferenceTrustworthy &&
    !becameNeverRebalance &&
    !shouldCloseDegenerateBreach
  );
}
