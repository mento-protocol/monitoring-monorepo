import type { Pool } from "envio";
import { isVirtualPool } from "../helpers.js";
import type { PoolUpdateSource } from "./sources.js";

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
 * Persistable counterpart to `effectiveThreshold` for `Int!`-typed fields
 * (GraphQL 32-bit signed, max ~2.1e9). Three distinct zero-cases need
 * three distinct persisted values so chart/table consumers don't have to
 * synthesize them from joins:
 *
 * - **never-rebalance** (`above=0, below=0, known=true`): persist `0`.
 *   Matches on-chain config; `isNeverRebalance(pool)` short-circuits the
 *   chart/health math upstream, so the value is informational. The 1e12
 *   in-memory sentinel would overflow `Int!` here.
 * - **asymmetric-active-zero** (one split side `>0`, other `=0`,
 *   `known=true`, reserves currently picking the zero side): persist
 *   `10000` (the same fallback `effectiveThreshold` uses for breach
 *   scoring). Without this, `oracle-chart.tsx` renders deviation as `0%`
 *   and the table renders `—` even though `hasHealthData=true` and the
 *   breach predicate scored against 10000 — making valid breach samples
 *   look in-band.
 * - **unknown-zero** (`known=false`, raw threshold `=0` because indexer
 *   hasn't read on-chain): persist `0`. The row's `hasHealthData=false`
 *   flag is what gates consumers; persisting 10000 here would leak the
 *   fallback into rows that the indexer explicitly marked untrusted.
 *
 * For any non-zero raw threshold, return it directly (already `Int!`-safe).
 */
export const persistableThreshold = (pool: {
  rebalanceThreshold: number;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
}): number => {
  if (pool.rebalanceThreshold > 0) return pool.rebalanceThreshold;
  if (isNeverRebalance(pool)) return 0;
  // From here: raw = 0 AND not never-rebalance. If thresholds are known,
  // this is the asymmetric-active-zero case (the OTHER side is positive
  // and the pool DOES rebalance on flip) — persist the 10000 fallback so
  // the chart's deviation-ratio math has a non-zero denominator. If
  // thresholds are unread, persist 0; `hasHealthData=false` on the row
  // signals consumers to skip.
  if (pool.rebalanceThresholdsKnown === true) return 10000;
  return 0;
};

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
 *  - `hasHealthData=false` short-circuit: defense-in-depth mirror of the
 *    UI's gate at `health.ts:230`. Indexer-side, the upstream
 *    `tokenDecimalsKnown` early-return in sortedOracles handlers prevents
 *    `computeHealthStatus` from being called on untrusted samples in the
 *    first place — but mirroring the gate keeps the function pure and
 *    answers any caller (parity tests, ad-hoc replay tooling) that
 *    bypasses the upstream guard.
 */
export function computeHealthStatus(
  pool: Pool,
  nowSeconds: bigint,
): IndexerHealthStatus {
  if (isVirtualPool(pool)) return "N/A";
  // `oracleOk=false` is an alertable freshness incident — keep it ABOVE the
  // hasHealthData gate so a stale-oracle pool doesn't get masked into "N/A"
  // just because the deviation accrual is also untrusted (codex P2 PR #370
  // #3214756056).
  if (!pool.oracleOk) return "CRITICAL";
  if (pool.hasHealthData === false) return "N/A";
  // Governance-configured "never rebalance" pools stay OK regardless of
  // priceDifference magnitude. Short-circuit explicitly so extreme reserve
  // skew can't trip the predicate via the `effectiveThreshold` 1e12 cushion.
  if (isNeverRebalance(pool)) return "OK";
  // Drained/effectively one-sided pools keep their faithful priceDifference,
  // but the degenerate flag takes them out of deviation health accounting.
  if (pool.degenerateReserves) return "OK";
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
// `computeHealthStatus`); see `isNeverRebalance` for why. Degenerate
// reserves also short-circuit because the enormous priceDifference is a
// faithful reserve-skew signal, not a deviation breach.
export function isInDeviationBreach(pool: Pool): boolean {
  if (isVirtualPool(pool)) return false;
  if (isNeverRebalance(pool)) return false;
  if (pool.degenerateReserves) return false;
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
  // A drained/effectively one-sided pool can produce a faithful but enormous
  // priceDifference. Keep the value, but do not open or continue breach
  // accounting from that sample; otherwise drained-pool windows dominate the
  // lifetime uptime counters. This must stay before the UpdateReserves
  // deferral below so a drain-to-degenerate UR closes immediately instead of
  // holding the previous breach anchor for the semantic handler.
  if (next.degenerateReserves) return 0n;
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
