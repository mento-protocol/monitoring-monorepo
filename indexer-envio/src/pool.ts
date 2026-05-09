// ---------------------------------------------------------------------------
// Pool and PoolSnapshot upsert logic, health status computation
// ---------------------------------------------------------------------------

import type { EffectCaller } from "envio";
import type {
  Pool,
  PoolSnapshot,
  PoolDailySnapshot,
  DeviationThresholdBreach,
} from "generated";
import {
  hourBucket,
  dayBucket,
  snapshotId,
  dailySnapshotId,
  extractAddressFromPoolId,
} from "./helpers";
import { computePriceDifference } from "./priceDifference";
import {
  compactFees,
  feesEffect,
  invertRateFeedEffect,
  rebalanceThresholdsEffect,
  referenceRateFeedIDEffect,
  reportExpiryEffect,
} from "./rpc/effects";
import { isVirtualPool } from "./helpers";
import { recordBreachTransition } from "./deviationBreach";

// ---------------------------------------------------------------------------
// Health status computation
// ---------------------------------------------------------------------------

/**
 * How long a pool may sit above the critical magnitude (5% over threshold)
 * before the status escalates from WARN to CRITICAL. Mirrors
 * `DEVIATION_BREACH_GRACE_SECONDS` in `ui-dashboard/src/lib/health.ts`.
 */
export const DEVIATION_BREACH_GRACE_SECONDS = 3600n;

/**
 * Tolerance + critical-magnitude thresholds as `num/den` pairs over the
 * rebalance threshold. Integer math avoids float pathology at the boundaries.
 *
 * Float-form mirrors live in `@mento-protocol/monitoring-config/thresholds`
 * (canonical for the dashboard + metrics-bridge probe). Parity with the
 * dashboard's float comparison is enforced by `test/healthStatusParity.test.ts`.
 * Any change here must update that file too.
 */
export const DEVIATION_TOLERANCE_NUM = 101n;
export const DEVIATION_TOLERANCE_DEN = 100n;
export const DEVIATION_CRITICAL_NUM = 105n;
export const DEVIATION_CRITICAL_DEN = 100n;

/**
 * Health-status union the indexer can emit. Narrower than the dashboard's
 * `HealthStatus` (no "WEEKEND" — that's a render-time reclassification of
 * stale-oracle CRITICAL).
 */
export type IndexerHealthStatus = "OK" | "WARN" | "CRITICAL" | "N/A";

/** Resolve the effective threshold in bps. The schema-default of 0 means the
 * indexer hasn't read the on-chain value yet — fall back to 10000 (100%) so
 * pools don't trip the breach predicate while we wait for the RPC self-heal.
 */
export const effectiveThreshold = (
  pool: Pick<Pool, "rebalanceThreshold">,
): bigint =>
  BigInt(pool.rebalanceThreshold > 0 ? pool.rebalanceThreshold : 10000);

/** True when `priceDifference` is strictly above the 5% critical-magnitude
 * line, integer-safe. Used by both the live status branch (here) and the
 * cumulative `criticalDurationSeconds` accrual in `deviationBreach.ts` to
 * keep them in lockstep. */
export const isAboveCriticalMagnitude = (
  priceDifference: bigint,
  threshold: bigint,
): boolean =>
  priceDifference * DEVIATION_CRITICAL_DEN > threshold * DEVIATION_CRITICAL_NUM;

/**
 * Mirror of `computeHealthStatus` in `ui-dashboard/src/lib/health.ts`; parity
 * is enforced by `test/healthStatusParity.test.ts`. The breach anchor
 * (`deviationBreachStartedAt`) is set at the 1.01x crossing in
 * `isInDeviationBreach`, so the 1h grace counts from when the pool first
 * exceeded tolerance.
 *
 * Intentional divergences NOT covered by the parity suite:
 *  - Oracle staleness: indexer reads the event-time `oracleOk` flag; the UI
 *    reads `oracleTimestamp + oracleExpiry` against wall clock at render time
 *    with per-chain fallbacks.
 *  - Weekend reclassification: only the UI has `isWeekend()` at render time.
 *    Indexed weekend-stale pools surface as CRITICAL here; the UI
 *    reclassifies them to WEEKEND.
 */
export function computeHealthStatus(
  pool: Pool,
  nowSeconds: bigint,
): IndexerHealthStatus {
  if (isVirtualPool(pool)) return "N/A";
  if (!pool.oracleOk) return "CRITICAL";
  const threshold = effectiveThreshold(pool);
  const diff = pool.priceDifference;
  const aboveTolerance =
    diff * DEVIATION_TOLERANCE_DEN > threshold * DEVIATION_TOLERANCE_NUM;
  if (!aboveTolerance) return "OK";
  if (!isAboveCriticalMagnitude(diff, threshold)) return "WARN";
  // Without a breach-start anchor (indexer hasn't populated it yet), stay
  // at WARN rather than spuriously escalating to CRITICAL.
  if (pool.deviationBreachStartedAt <= 0n) return "WARN";
  const withinGrace =
    nowSeconds - pool.deviationBreachStartedAt < DEVIATION_BREACH_GRACE_SECONDS;
  return withinGrace ? "WARN" : "CRITICAL";
}

// Strict `>` at the tolerance line matches `computeHealthStatus`. Oracle
// staleness is intentionally NOT counted — this tracks price action only.
export function isInDeviationBreach(pool: Pool): boolean {
  if (isVirtualPool(pool)) return false;
  return (
    pool.priceDifference * DEVIATION_TOLERANCE_DEN >
    effectiveThreshold(pool) * DEVIATION_TOLERANCE_NUM
  );
}

export function nextDeviationBreachStartedAt(
  prev: Pool | undefined,
  next: Pool,
  blockTimestamp: bigint,
  source?: PoolUpdateSource,
): bigint {
  const wasBreachedPrice = prev ? isInDeviationBreach(prev) : false;
  const wasBreachedAnchor = prev ? prev.deviationBreachStartedAt > 0n : false;
  const isBreached = isInDeviationBreach(next);
  if (!isBreached) {
    // Defer the close when this transition is being driven by
    // UpdateReserves. The FPMM contract emits ReservesUpdated inside
    // swap/rebalance/mint/burn (often MULTIPLE times — pre- and post-
    // state), so an initial UR can pull priceDifference to / below
    // threshold before the semantic handler runs. Use the ANCHOR, not
    // price, to decide "is there an open breach to hold" — price may
    // already read healthy after UR#1, but the anchor is still set.
    // Holding it keeps the falling-edge attribution with the eventual
    // semantic handler (Rebalance → "rebalance", Swap → "swap", etc.)
    // instead of the generic UR "unknown".
    if (wasBreachedAnchor && source === "fpmm_update_reserves" && prev) {
      return prev.deviationBreachStartedAt;
    }
    return 0n;
  }
  if (!wasBreachedPrice) return blockTimestamp;
  // Self-heal: a breached row with a 0n sentinel (partial restore, pre-backfill
  // state, etc) would stay 0n forever. Adopt the current block time as a
  // best-effort start so the UI stops suppressing the indicator.
  return prev!.deviationBreachStartedAt > 0n
    ? prev!.deviationBreachStartedAt
    : blockTimestamp;
}

/** Maintain the open-breach peak denormalized on Pool. Mirrors the
 * `peakPriceDifference` tracked on the open `DeviationThresholdBreach`
 * row, but lives on Pool so the rollup query the live uptime tile uses
 * doesn't need to join to the breach row. Resets to 0 when no open
 * breach; otherwise carries `max(prev peak, current diff)`. */
export function nextOpenBreachPeak(prev: Pool | undefined, next: Pool): bigint {
  if (next.deviationBreachStartedAt === 0n) return 0n;
  const prevPeak = prev?.currentOpenBreachPeak ?? 0n;
  return prevPeak > next.priceDifference ? prevPeak : next.priceDifference;
}

/** Maintain the open-breach entry threshold denormalized on Pool. Captures
 * `rebalanceThreshold` at the rising edge so the live-uptime gate scores
 * the peak against the same threshold the persisted accrual uses (entry,
 * not current). Resets to 0 when no open breach; held across continuing
 * breach events so a mid-breach `FPMMRebalanceThresholdUpdated` can't
 * shift the live verdict. Self-heals from the 0 sentinel: if the breach
 * opened before RPC backfilled `rebalanceThreshold` and a real value
 * arrives mid-breach, adopt it once and then hold. */
export function nextOpenBreachEntryThreshold(
  prev: Pool | undefined,
  next: Pool,
): number {
  if (next.deviationBreachStartedAt === 0n) return 0;
  const prevAnchor = prev?.deviationBreachStartedAt ?? 0n;
  if (prevAnchor === 0n) return next.rebalanceThreshold; // rising edge
  // Continuing: hold the previously-captured entry value, but heal when
  // the captured value is the 0 RPC-pending sentinel and we now have one.
  const stored = prev?.currentOpenBreachEntryThreshold ?? 0;
  return stored > 0 ? stored : next.rebalanceThreshold;
}

// ---------------------------------------------------------------------------
// Pool upsert (with cumulative fields)
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY = {
  virtual_pool_factory: 100,
  fpmm_factory: 90,
  fpmm_rebalanced: 50,
  fpmm_update_reserves: 40,
  // Below state-sync events: a threshold update doesn't change reserves
  // or oracle, so the legacy "preferred-source" stickiness should keep
  // whichever live event source wrote last.
  fpmm_threshold_updated: 35,
  fpmm_swap: 30,
  fpmm_mint: 20,
  fpmm_burn: 20,
} as const;

/** Values the indexer passes as `source` when calling upsertPool / the
 *  breach helpers. Typing this as a union (rather than bare string) means
 *  a typo like "fpmm_update_reseves" is a compile error instead of a
 *  silently-unmatched deferral branch. */
export type PoolUpdateSource = keyof typeof SOURCE_PRIORITY;

// `existingSource` is typed as `string` because Pool.source is stored as
// a plain string in the DB (potentially including legacy values not in
// the current union). Use a safe lookup helper so unknown strings fall
// through to priority 0 without an unchecked cast.
const sourcePriority = (source: string): number =>
  (SOURCE_PRIORITY as Record<string, number>)[source] ?? 0;

const pickPreferredSource = (
  existingSource: string | undefined,
  incomingSource: PoolUpdateSource,
): string => {
  if (!existingSource) return incomingSource;
  return sourcePriority(incomingSource) >= sourcePriority(existingSource)
    ? incomingSource
    : existingSource;
};

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

export type PoolContext = {
  effect: EffectCaller;
  Pool: {
    get: (id: string) => Promise<Pool | undefined>;
    set: (entity: Pool) => void;
  };
  DeviationThresholdBreach: {
    get: (id: string) => Promise<DeviationThresholdBreach | undefined>;
    set: (entity: DeviationThresholdBreach) => void;
  };
};

/** Self-heal `invertRateFeed` when it was never successfully read at pool
 * deployment (factory's RPC fan-out hit a transient blip → the field rode
 * the schema default). Returns the same pool when already healed / not
 * applicable, otherwise returns a copy with `invertRateFeed` corrected and
 * `invertRateFeedKnown: true`.
 *
 * Must be called before any code path reads `pool.invertRateFeed` to
 * compute oracle/health/priceDifference state — including the
 * `OracleReported`/`MedianUpdated` handlers (which write directly without
 * going through `upsertPool`) and the `UpdateReserves`/`Rebalanced`
 * handlers (which read `existing.invertRateFeed` before `upsertPool` runs).
 *
 * Effect-level dedup means this is one RPC read per (pool, batch) when
 * unhealed; once `invertRateFeedKnown` flips true, subsequent calls are
 * pure object identity returns — no RPC, no Pool.set side-effect. The
 * caller's own Pool.set persists the healed value. */
export async function selfHealInvertRateFeed(
  context: { effect: EffectCaller },
  pool: Pool,
): Promise<Pool> {
  if (pool.invertRateFeedKnown || pool.source === "" || isVirtualPool(pool)) {
    return pool;
  }
  const poolAddr = extractAddressFromPoolId(pool.id);
  const invert = await context.effect(invertRateFeedEffect, {
    chainId: pool.chainId,
    poolAddress: poolAddr,
  });
  if (invert === undefined) return pool;
  return {
    ...pool,
    invertRateFeed: invert,
    invertRateFeedKnown: true,
  };
}

/** Self-heal `rebalanceThresholdAbove/Below` when the factory's
 * `rebalanceThresholdsEffect` failed at deploy. Without this, a transient
 * RPC blip would permanently leave both split fields at 0 → derive returns
 * null forever → the entity-derived path is dead for that pool. Block-
 * scoped read (effect is `cache: false` because thresholds are governance-
 * mutable). The caller's own Pool.set persists the healed values. */
export async function selfHealRebalanceThresholds(
  context: { effect: EffectCaller },
  pool: Pool,
  blockNumber: bigint,
): Promise<Pool> {
  if (
    pool.rebalanceThresholdsKnown ||
    pool.source === "" ||
    isVirtualPool(pool)
  ) {
    return pool;
  }
  const poolAddr = extractAddressFromPoolId(pool.id);
  const thresholds = await context.effect(rebalanceThresholdsEffect, {
    chainId: pool.chainId,
    poolAddress: poolAddr,
    blockNumber,
  });
  if (thresholds === undefined) return pool;
  // Refresh the legacy `rebalanceThreshold` only when at least one side is
  // configured. Both-zero means "never rebalance" — leave the legacy field
  // at whatever the next state-sync event pins.
  const broadest = Math.max(thresholds.above, thresholds.below);
  return {
    ...pool,
    rebalanceThresholdAbove: thresholds.above,
    rebalanceThresholdBelow: thresholds.below,
    rebalanceThresholdsKnown: true,
    rebalanceThreshold: broadest > 0 ? broadest : pool.rebalanceThreshold,
  };
}

export type SnapshotContext = {
  PoolSnapshot: {
    get: (id: string) => Promise<PoolSnapshot | undefined>;
    set: (entity: PoolSnapshot) => void;
  };
  PoolDailySnapshot: {
    get: (id: string) => Promise<PoolDailySnapshot | undefined>;
    set: (entity: PoolDailySnapshot) => void;
  };
};

/** Default oracle field values (for VirtualPools or when RPC call fails) */
export const DEFAULT_ORACLE_FIELDS = {
  oracleOk: false,
  oraclePrice: 0n,
  oracleTimestamp: 0n,
  oracleTxHash: "",
  oracleExpiry: 0n,
  oracleNumReporters: 0,
  referenceRateFeedID: "",
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
  tokenDecimals?: { token0Decimals: number; token1Decimals: number };
  /** Caller-provided pool snapshot. Handlers that have already done
   * `context.Pool.get(poolId)` (e.g. FPMM UR/Rebalanced, which fetch it
   * concurrently with RPC) should pass the result here — wrapped as
   * `{ pool: ... }` so `pool: undefined` (fresh pool) is distinguishable
   * from "not passed". When `undefined`, upsertPool does its own lookup. */
  existing?: { pool: Pool | undefined };
}): Promise<Pool> => {
  const existingInitial = existingOverride
    ? (existingOverride.pool ??
      defaultPool(chainId, poolId, { token0, token1 }))
    : await getOrCreatePool(context, chainId, poolId, { token0, token1 });
  // Self-heal invertRateFeed up front so every downstream computation
  // (priceDifference, oraclePrice flip, breach status) sees the corrected
  // orientation. Same helper that handlers call before reading the field.
  const existing = await selfHealInvertRateFeed(context, existingInitial);

  // Self-heal: if referenceRateFeedID is missing (transient RPC failure at
  // pool creation), retry now so oracle events can start flowing.
  // Use the raw address (not the namespaced poolId) for RPC calls.
  const poolAddr = extractAddressFromPoolId(poolId);
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
      healedOracleDelta = { referenceRateFeedID: rateFeedID };
      const expiry = await context.effect(reportExpiryEffect, {
        chainId,
        rateFeedID,
        blockNumber,
      });
      if (expiry !== undefined) healedOracleDelta.oracleExpiry = expiry;
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
    // Persist token decimals if provided (set once at pool creation)
    token0Decimals: tokenDecimals?.token0Decimals ?? existing.token0Decimals,
    token1Decimals: tokenDecimals?.token1Decimals ?? existing.token1Decimals,
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
  const hasContractPriceDiff =
    oracleDelta != null &&
    "priceDifference" in oracleDelta &&
    oracleDelta.priceDifference !== undefined;
  const priceDifference = hasContractPriceDiff
    ? oracleDelta.priceDifference!
    : !isVirtualPool(next) && next.oraclePrice > 0n
      ? computePriceDifference(next)
      : next.priceDifference;

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

// ---------------------------------------------------------------------------
// PoolSnapshot upsert
// ---------------------------------------------------------------------------

export const upsertSnapshot = async ({
  context,
  pool,
  blockTimestamp,
  blockNumber,
  swapDelta,
  rebalanceDelta,
  mintDelta,
  burnDelta,
}: {
  context: SnapshotContext;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  mintDelta?: boolean;
  burnDelta?: boolean;
}): Promise<void> => {
  const hourTs = hourBucket(blockTimestamp);
  const id = snapshotId(pool.id, hourTs);
  const existing = await context.PoolSnapshot.get(id);

  const snapshot: PoolSnapshot = existing
    ? {
        ...existing,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: existing.swapCount + (swapDelta ? 1 : 0),
        swapVolume0: existing.swapVolume0 + (swapDelta?.volume0 ?? 0n),
        swapVolume1: existing.swapVolume1 + (swapDelta?.volume1 ?? 0n),
        rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
        mintCount: existing.mintCount + (mintDelta ? 1 : 0),
        burnCount: existing.burnCount + (burnDelta ? 1 : 0),
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      }
    : {
        id,
        chainId: pool.chainId,
        poolId: pool.id,
        timestamp: hourTs,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: swapDelta ? 1 : 0,
        swapVolume0: swapDelta?.volume0 ?? 0n,
        swapVolume1: swapDelta?.volume1 ?? 0n,
        rebalanceCount: rebalanceDelta ? 1 : 0,
        mintCount: mintDelta ? 1 : 0,
        burnCount: burnDelta ? 1 : 0,
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        blockNumber,
      };

  context.PoolSnapshot.set(snapshot);

  // Also write the day-bucketed rollup. Callers never need to invoke this
  // directly — handlers call upsertSnapshot, both entities get updated.
  await upsertDailySnapshot({
    context,
    pool,
    blockTimestamp,
    blockNumber,
    swapDelta,
    rebalanceDelta,
    mintDelta,
    burnDelta,
  });
};

// ---------------------------------------------------------------------------
// PoolDailySnapshot upsert — same read-merge-write pattern as upsertSnapshot,
// but bucketed per UTC day. Lets full-history pool charts fit in a single
// Hasura page (Envio's hosted endpoint caps every query at 1000 rows).
// Invoked from upsertSnapshot; exported so tests can exercise it directly.
// ---------------------------------------------------------------------------

export const upsertDailySnapshot = async ({
  context,
  pool,
  blockTimestamp,
  blockNumber,
  swapDelta,
  rebalanceDelta,
  mintDelta,
  burnDelta,
}: {
  context: SnapshotContext;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  mintDelta?: boolean;
  burnDelta?: boolean;
}): Promise<void> => {
  const dayTs = dayBucket(blockTimestamp);
  const id = dailySnapshotId(pool.id, dayTs);
  const existing = await context.PoolDailySnapshot.get(id);

  const snapshot: PoolDailySnapshot = existing
    ? {
        ...existing,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: existing.swapCount + (swapDelta ? 1 : 0),
        swapVolume0: existing.swapVolume0 + (swapDelta?.volume0 ?? 0n),
        swapVolume1: existing.swapVolume1 + (swapDelta?.volume1 ?? 0n),
        rebalanceCount: existing.rebalanceCount + (rebalanceDelta ? 1 : 0),
        mintCount: existing.mintCount + (mintDelta ? 1 : 0),
        burnCount: existing.burnCount + (burnDelta ? 1 : 0),
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        cumulativeHealthBinarySeconds: pool.healthBinarySeconds,
        cumulativeHealthTotalSeconds: pool.healthTotalSeconds,
        blockNumber,
      }
    : {
        id,
        chainId: pool.chainId,
        poolId: pool.id,
        timestamp: dayTs,
        reserves0: pool.reserves0,
        reserves1: pool.reserves1,
        swapCount: swapDelta ? 1 : 0,
        swapVolume0: swapDelta?.volume0 ?? 0n,
        swapVolume1: swapDelta?.volume1 ?? 0n,
        rebalanceCount: rebalanceDelta ? 1 : 0,
        mintCount: mintDelta ? 1 : 0,
        burnCount: burnDelta ? 1 : 0,
        cumulativeSwapCount: pool.swapCount,
        cumulativeVolume0: pool.notionalVolume0,
        cumulativeVolume1: pool.notionalVolume1,
        cumulativeHealthBinarySeconds: pool.healthBinarySeconds,
        cumulativeHealthTotalSeconds: pool.healthTotalSeconds,
        blockNumber,
      };

  context.PoolDailySnapshot.set(snapshot);
};
