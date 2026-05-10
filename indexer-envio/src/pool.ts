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
import type { HandlerContext } from "generated/src/Types";
import { ZERO_ADDRESS } from "./constants";
import {
  hourBucket,
  dayBucket,
  snapshotId,
  dailySnapshotId,
  extractAddressFromPoolId,
} from "./helpers";
import { computePriceDifference, parseDecimalsPair } from "./priceDifference";
import {
  compactFees,
  feesEffect,
  invertRateFeedEffect,
  rebalanceThresholdsEffect,
  referenceRateFeedIDEffect,
  reportExpiryEffect,
  tokenDecimalsScalingEffect,
  vpExchangeIdEffect,
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

/** True iff governance has explicitly configured this pool to never
 * rebalance — BOTH `rebalanceThresholdAbove === 0` AND
 * `rebalanceThresholdBelow === 0` AND `rebalanceThresholdsKnown=true`.
 * Distinct from the schema-default unknown case (`rebalanceThresholdsKnown=false`),
 * where the breach predicate falls back to a 10000-bps under-bound until
 * self-heal lands.
 *
 * Cannot infer from `rebalanceThreshold` alone: that's the ACTIVE side
 * picked by `pickActiveThreshold` based on current reserve direction. An
 * asymmetric pool with `above=0, below=300` legitimately persists
 * `rebalanceThreshold=0` while reservePrice is on the above side, even
 * though the pool DOES rebalance on the below side. Both split fields
 * must be 0 for "never rebalance" to be the right semantic.
 *
 * Used to short-circuit breach/health predicates rather than relying on
 * the `effectiveThreshold` 1e12 sentinel: explicit short-circuit means an
 * extreme reserve-skew priceDifference > 1.01e12 still resolves to "no
 * breach", as governance intended.
 */
export const isNeverRebalance = (pool: {
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
}): boolean =>
  // STRICT equality: undefined is NOT treated as 0. A pool entity always
  // has both split fields populated (Int! schema), so this only matters
  // for synthetic test inputs. Defaulting undefined→0 would let a caller
  // claim never-rebalance without populating the split fields, which is
  // the same partial-shape pitfall the dashboard mirror guards against.
  pool.rebalanceThresholdAbove === 0 &&
  pool.rebalanceThresholdBelow === 0 &&
  pool.rebalanceThresholdsKnown === true;

/** Resolve the effective threshold in bps. Three states:
 *  - `> 0`: the on-chain configured threshold (active side).
 *  - `0` AND `rebalanceThresholdsKnown=true`: governance configured the pool
 *    to never rebalance. Treat as effectively infinite so the breach
 *    predicate never trips — the pool isn't supposed to rebalance. Callers
 *    that take a different code path on never-rebalance pools should also
 *    check `isNeverRebalance(pool)` and short-circuit upstream rather than
 *    relying on the 1e12 sentinel — that cushion is unbounded-skew-tolerant
 *    in practice but not by construction.
 *  - `0` AND `rebalanceThresholdsKnown=false`: indexer hasn't read on-chain
 *    yet. Fall back to 10000 (100%) so the predicate doesn't false-trip
 *    while waiting for self-heal.
 *
 * The schema-default unknown case must NOT collapse with the legitimate
 * "never rebalance" case — both have `rebalanceThreshold === 0`, but only
 * the latter has `rebalanceThresholdsKnown=true`.
 */
export const effectiveThreshold = (pool: {
  rebalanceThreshold: number;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  // Optional: callers passing a synthetic threshold value (e.g.
  // `deviationBreach` healing from a captured entry threshold) may not
  // carry the Known flag. In that case we treat `0` as the unread
  // sentinel and fall back to 10000 — matches pre-Lever-4 behaviour.
  rebalanceThresholdsKnown?: boolean;
}): bigint => {
  if (pool.rebalanceThreshold > 0) return BigInt(pool.rebalanceThreshold);
  // Distinguish governance-disabled "never rebalance" (BOTH split sides
  // 0 + Known) from an asymmetric pool whose active side just happens to
  // be 0 right now. Otherwise an `above=0, below=300` pool with reserves
  // currently picking the above side would suppress all deviation
  // alerts via the 1e12 cushion even though the below side is real.
  if (isNeverRebalance(pool)) return 10n ** 12n;
  return 10000n;
};

/**
 * Persistable counterpart to `effectiveThreshold` for any field typed as
 * GraphQL `Int!` (32-bit signed, max ~2.1e9). Returns the raw on-chain
 * active threshold in bps — never the in-memory sentinels:
 *
 * - 1e12 (never-rebalance) overflows `Int!`; Postgres rejects as `int4`
 *   out-of-range.
 * - 10000 (unknown-zero fallback) leaks into `OracleSnapshot.rebalanceThreshold`
 *   on rows that `recordHealthSample` flags `hasHealthData=false`. Oracle
 *   tab/chart consumers that read the row directly would render a fake
 *   "100% threshold" deviation against the row's preserved `priceDifference`
 *   instead of degrading to no-data.
 *
 * Consumers that need to distinguish never-rebalance, asymmetric-active-zero,
 * and unknown-zero must join the Pool entity (`rebalanceThresholdsKnown` +
 * `rebalanceThresholdAbove/Below`) and the row's `hasHealthData` flag.
 */
export const persistableThreshold = (pool: {
  rebalanceThreshold: number;
}): number => pool.rebalanceThreshold;

/**
 * Breach-row entry capture: the threshold the breach predicate
 * (`isInDeviationBreach` → `effectiveThreshold(pool)`) was scored against
 * at the rising edge. Differs from `persistableThreshold` because the
 * breach row's `entryRebalanceThreshold` field exists to score severity
 * across the breach lifecycle — capturing raw 0 on an asymmetric pool's
 * zero-threshold side would let a later reserve flip re-score history
 * against the post-flip opposite side (codex P2 #3214513401, PR 1.6).
 *
 * Returns:
 *  - active threshold (bps) when positive — symmetric / on-active-side asymmetric.
 *  - 10000 when active is 0 AND `rebalanceThresholdsKnown=false` (cold-start
 *    under-bound — predicate scored against the same fallback) OR the pool
 *    is asymmetric on its zero side (`above=0, below>0` etc.).
 *  - 0 when `isNeverRebalance` — returning the never-rebalance 1e12 cushion
 *    would overflow `Int!`. Never-rebalance pools cannot have an open breach
 *    (the predicate short-circuits them), so this branch is defense-in-depth
 *    only — if reached, the row's later `criticalDurationSeconds` accrual
 *    would resolve to 0 via `effectiveThreshold(pool)`'s 1e12 cushion.
 */
export const breachEntryThreshold = (pool: {
  rebalanceThreshold: number;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
}): number => {
  if (isNeverRebalance(pool)) return 0;
  return Number(effectiveThreshold(pool));
};

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
  // Governance-configured "never rebalance" pools stay OK regardless of
  // priceDifference magnitude. Short-circuit explicitly so extreme reserve
  // skew can't trip the predicate via the `effectiveThreshold` 1e12 cushion.
  if (isNeverRebalance(pool)) return "OK";
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
// Never-rebalance pools always short-circuit to false (mirrors
// `computeHealthStatus`); see `isNeverRebalance` for why.
export function isInDeviationBreach(pool: Pool): boolean {
  if (isVirtualPool(pool)) return false;
  if (isNeverRebalance(pool)) return false;
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
 * the EFFECTIVE threshold at the rising edge (`breachEntryThreshold(next)`,
 * not raw `rebalanceThreshold`) so the live-uptime gate scores the peak
 * against the same threshold the breach predicate (`isInDeviationBreach` →
 * `effectiveThreshold(pool)`) used. Asymmetric pools on their zero-threshold
 * side need this: raw `rebalanceThreshold === 0` while the predicate scored
 * against the 10000-bps fallback; capturing 0 here would let the closing
 * fallback chain in `recordBreachTransition` reach for the post-flip
 * opposite side's active value instead. Held across continuing breach events
 * so a mid-breach `FPMMRebalanceThresholdUpdated` (or a side flip) can't
 * shift the live verdict. Resets to 0 when no open breach. */
export function nextOpenBreachEntryThreshold(
  prev: Pool | undefined,
  next: Pool,
): number {
  if (next.deviationBreachStartedAt === 0n) return 0;
  const prevAnchor = prev?.deviationBreachStartedAt ?? 0n;
  // Rising edge — capture the predicate-scoring threshold (10000 fallback
  // for asymmetric-zero-side pools), matching the entity row capture in
  // `recordBreachTransition`. See deviationBreach.ts for the full
  // asymmetric-side-flip rationale (codex P2 #3214513401, PR 1.6).
  if (prevAnchor === 0n) return breachEntryThreshold(next);
  // Continuing: never overwrite a captured value. The pre-PR-1.6
  // heal-from-zero branch is retired for the same reason as the entity
  // row's heal (see deviationBreach.ts) — overwriting an old captured 0
  // with `next.rebalanceThreshold` would re-score history against the
  // post-flip opposite side. Old rows with stored=0 stay 0; the closing
  // fallback chain in `recordBreachTransition` defaults them to the
  // 10000 effective floor.
  return prev?.currentOpenBreachEntryThreshold ?? 0;
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
  // Used by `selfHealWrappedExchangeId` to patch the back-reference on the
  // matching exchange row when a VP heals its `wrappedExchangeId`.
  BiPoolExchange: HandlerContext["BiPoolExchange"];
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

/** Self-heal `token0Decimals` / `token1Decimals` when the factory's
 * `tokenDecimalsScalingEffect` reads failed at deploy. Without this, a
 * non-18-decimal pool whose factory RPC blipped would silently keep the
 * schema default 18/18 forever — `normalizeTo18` would not scale the
 * affected reserve, and every priceDifference computation downstream
 * would be wrong by `10^(18 - real_dec)` factor.
 *
 * Cache-true effect: `tokenDecimalsScalingEffect` is per-(chain, pool, fn)
 * and the on-chain decimals are immutable, so this is one RPC pair per
 * unhealed pool across the entire run. Once `tokenDecimalsKnown` flips
 * true, subsequent calls are pure object-identity returns.
 *
 * Caller's own `Pool.set` persists the healed values. */
export async function selfHealTokenDecimals(
  context: { effect: EffectCaller },
  pool: Pool,
): Promise<Pool> {
  // VPs were previously skipped because they don't go through the local
  // priceDifference recompute path. But `buildSwapTraderFields` still uses
  // `token0Decimals` / `token1Decimals` to compute `volumeUsdWei` and
  // leaderboard snapshots — a non-18-decimal USD leg would stay mis-scaled
  // for a VP with a deploy-time decimal blip. Cache:true effect, so the
  // RPC pair fires once per VP across the run regardless of how many
  // events touch it.
  if (pool.tokenDecimalsKnown || pool.source === "") {
    return pool;
  }
  const poolAddr = extractAddressFromPoolId(pool.id);
  const [dec0Raw, dec1Raw] = await Promise.all([
    context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals0",
      fallbackTokenAddress: pool.token0,
    }),
    context.effect(tokenDecimalsScalingEffect, {
      chainId: pool.chainId,
      poolAddress: poolAddr,
      fn: "decimals1",
      fallbackTokenAddress: pool.token1,
    }),
  ]);
  const parsed = parseDecimalsPair(dec0Raw, dec1Raw);
  if (!parsed.tokenDecimalsKnown) return pool;
  return { ...pool, ...parsed };
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

/** Self-heal `Pool.wrappedExchangeId` for VirtualPools whose
 * `VirtualPoolDeployed` event fired pre-start_block (and so the bytecode
 * extraction in the factory handler never ran). Reads the VP bytecode
 * once per address (the effect is `cache: true` — bytecode is immutable
 * for a deployed contract — so the actual RPC fires exactly once per VP
 * across the whole sync). Returns the (possibly healed) Pool — caller
 * persists. Also patches the matching `BiPoolExchange.wrappedByPoolId`
 * back-reference if the exchange row already exists, so the dashboard's
 * `wrappedByPoolId`-keyed GraphQL query finds the join after a heal that
 * only the Pool side knew about.
 *
 * No-op on FPMM pools and on VPs that already have the field set. */
export async function selfHealWrappedExchangeId(
  context: PoolContext,
  pool: Pool,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<Pool> {
  if (!isVirtualPool(pool) || pool.wrappedExchangeId) return pool;
  const poolAddr = extractAddressFromPoolId(pool.id);
  const result = await context.effect(vpExchangeIdEffect, {
    chainId: pool.chainId,
    vpAddress: poolAddr,
  });
  if (!result) return pool;
  const exchangeRowId = `${pool.chainId}-${result.exchangeId}`;
  const exchange = await context.BiPoolExchange.get(exchangeRowId);
  let healedFeedId = pool.referenceRateFeedID;
  if (exchange) {
    if (exchange.wrappedByPoolId !== pool.id) {
      context.BiPoolExchange.set({
        ...exchange,
        wrappedByPoolId: pool.id,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
    }
    // Once we've set wrappedByPoolId, ensureBiPoolExchange's null-guarded
    // retry path won't re-run the feedID mirror on subsequent BucketsUpdated
    // events. Mirror it here too so the oracle-price tile lights up
    // immediately on first self-heal — otherwise it'd stay "—" until the
    // NEXT bucket reset (~360s), even though the feedID is in scope.
    await mirrorFeedIdToPool(
      context,
      pool.id,
      exchange.referenceRateFeedID,
      blockNumber,
      blockTimestamp,
    );
    // CRUCIAL: also flow the mirrored feedID back to the caller so
    // `upsertPool`'s next spread doesn't overwrite the just-persisted
    // value. `mirrorFeedIdToPool` does its own `Pool.set`, but the
    // healed Pool returned from this function feeds into `next` in
    // upsertPool which then persists again — without carrying the
    // updated feedID here, that second write would blank the mirror
    // that just landed.
    if (
      exchange.referenceRateFeedID &&
      exchange.referenceRateFeedID !== ZERO_ADDRESS
    ) {
      healedFeedId = exchange.referenceRateFeedID;
    }
  }
  return {
    ...pool,
    wrappedExchangeId: result.exchangeId,
    referenceRateFeedID: healedFeedId,
  };
}

/** Mirror a v2 exchange's `referenceRateFeedID` onto its wrapping
 * VirtualPool's Pool row so the existing SortedOracles `getPoolsByFeed`
 * lookup picks up the VP naturally. Idempotent — no-op when already in
 * sync. Skips zero/empty feedIDs (still pre-RPC-backfill or destroyed
 * exchange) so a transient source value can't blank a previously-set
 * link. Used from both directions of the VP↔BiPoolExchange linkage
 * (VirtualPoolDeployed forward, BiPoolManager.ExchangeCreated reverse,
 * plus `selfHealWrappedExchangeId` post-self-heal).
 *
 * Context narrowed to just `Pool` access — callers from both PoolContext
 * (upsertPool path) and HandlerContext (event handlers) work. */
export async function mirrorFeedIdToPool(
  context: { Pool: PoolContext["Pool"] },
  poolId: string,
  feedId: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  if (!feedId || feedId === ZERO_ADDRESS) return;
  const pool = await context.Pool.get(poolId);
  if (!pool || pool.referenceRateFeedID === feedId) return;
  context.Pool.set({
    ...pool,
    referenceRateFeedID: feedId,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });
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
  // (factory-direct value or bytecode read). FPMMs never set it.
  wrappedExchangeId: undefined,
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
  const wrappedHealed =
    invertHealed.wrappedExchangeId || !isVirtualPool(invertHealed)
      ? invertHealed
      : await selfHealWrappedExchangeId(
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
      if (expiry !== undefined) {
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
