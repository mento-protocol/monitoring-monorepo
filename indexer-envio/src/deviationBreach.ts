// ---------------------------------------------------------------------------
// DeviationThresholdBreach lifecycle
//
// Per-breach history rows. Created on the rising edge (pool crosses strictly
// above the 1% tolerance line: priceDifference * 100 > rebalanceThreshold *
// 101), updated while open (peak price, rebalance attempts), closed on the
// falling edge with durations measured in trading-seconds (FX weekends
// excluded).
//
// Also rolls the closed-breach durations into two cumulative counters on
// the Pool itself (`cumulativeBreachSeconds`, `cumulativeCriticalSeconds`)
// so the UI can compute all-time uptime % without paginating history.
// `cumulativeCriticalSeconds` only credits breaches whose peak crossed the
// 5% critical-magnitude line — small breaches that never escalated are
// counted toward `cumulativeBreachSeconds` only.
// ---------------------------------------------------------------------------

import type { Pool, DeviationThresholdBreach } from "generated";
import {
  breachEntryThreshold,
  DEVIATION_BREACH_GRACE_SECONDS,
  effectiveThreshold,
  isAboveCriticalMagnitude,
} from "./pool";
import { tradingSecondsInRange } from "./healthScore";

export type BreachContext = {
  DeviationThresholdBreach: {
    get: (id: string) => Promise<DeviationThresholdBreach | undefined>;
    set: (entity: DeviationThresholdBreach) => void;
  };
};

/** User-facing categories stored on `DeviationThresholdBreach`. Narrower
 * than the indexer's internal `source` vocabulary; `classifyBreachEvent`
 * maps the latter into this set. Kept in sync with the label dictionaries
 * in `ui-dashboard/src/components/breach-history-panel.tsx`. */
export type BreachEventCategory =
  | "rebalance"
  | "swap"
  | "liquidity"
  | "oracle_update"
  | "threshold_change"
  | "unknown";

/** Maps the indexer's internal `source` vocabulary (which tracks WHICH
 * handler fired, regardless of the Pool's sticky preferred-source) to the
 * user-facing categories.
 *
 * The `source` argument here is the raw triggering source of the CURRENT
 * event, NOT `pool.source` — the latter is priority-picked and sticky
 * (a factory-created pool stays "fpmm_factory" forever) and so is useless
 * for attributing which event caused a transition. */
export function classifyBreachEvent(source: string): BreachEventCategory {
  if (source.includes("virtual")) return "unknown";
  if (source === "fpmm_rebalanced") return "rebalance";
  if (source === "fpmm_swap") return "swap";
  if (source === "fpmm_mint" || source === "fpmm_burn") return "liquidity";
  if (source === "fpmm_factory" || source === "fpmm_threshold_updated")
    return "threshold_change";
  if (source === "oracle_reported" || source === "median_updated")
    return "oracle_update";
  // `fpmm_update_reserves` intentionally maps to "unknown": the FPMM
  // contract emits ReservesUpdated inside swap/mint/burn, so the
  // UpdateReserves handler often fires just before the semantic handler
  // (Swap / Mint / Burn) in the same tx. If we categorised it as
  // "liquidity" it would steal attribution from real swap-driven
  // breaches. "unknown" is the honest answer — the next handler in the
  // tx carries the real category if the breach still holds.
  return "unknown";
}

export type BreachTrigger = {
  blockTimestamp: bigint;
  blockNumber: bigint;
  txHash: string;
  /** Triggering event's raw source (see `classifyBreachEvent`). */
  source: string;
  /** Strategy contract that fired the rebalance, if this transition was
   * caused by a RebalanceEvent. Ignored otherwise. */
  strategy?: string;
};

/** Deterministic id for the currently-open breach of a pool. Keyed on the
 * rising-edge timestamp (which is stored on the Pool as
 * `deviationBreachStartedAt`), so we can always look up the open row
 * without needing a separate "active-id" pointer field. */
export function openBreachId(poolId: string, startedAt: bigint): string {
  return `${poolId}-${startedAt}`;
}

/** Inspect the transition between `prev` and `next` pool states and write
 * the appropriate DeviationThresholdBreach side-effects (create on rising
 * edge, update on continuing breach, close on falling edge). Caller must
 * still call `context.Pool.set(...)` with the rolled-up counters returned
 * in `poolUpdate`; the helper does not touch the Pool entity directly to
 * keep the upsert flow linear.
 *
 * Returns `poolUpdate`: partial Pool fields to merge (cumulative counters
 * incremented when a breach closes).
 */
export async function recordBreachTransition(
  context: BreachContext,
  prev: Pool | undefined,
  next: Pool,
  trigger: BreachTrigger,
): Promise<Partial<Pool>> {
  // Use the anchor (`deviationBreachStartedAt`) as the authoritative "is a
  // breach in progress" signal, not the price predicate (`isInDeviationBreach`
  // → above the 1% tolerance line). Two reasons:
  //   1. UpdateReserves DEFERS close by holding the anchor — if we trusted
  //      price here, the subsequent Rebalance handler would see wasBreached
  //      = false and skip the close entirely, leaving the row with
  //      `endedByEvent = undefined` forever.
  //   2. The anchor is set in `nextDeviationBreachStartedAt` with source
  //      awareness, so it already encodes "should this be treated as a
  //      continuing breach" more correctly than a raw price check.
  const wasBreached = prev ? prev.deviationBreachStartedAt > 0n : false;
  const isBreached = next.deviationBreachStartedAt > 0n;

  if (!wasBreached && !isBreached) return {};

  const poolId = next.id;
  const category = classifyBreachEvent(trigger.source);
  const isRebalance = trigger.source === "fpmm_rebalanced";

  // Rising edge ------------------------------------------------------------
  if (!wasBreached && isBreached) {
    const row: DeviationThresholdBreach = {
      id: openBreachId(poolId, trigger.blockTimestamp),
      chainId: next.chainId,
      poolId,
      startedAt: trigger.blockTimestamp,
      startedAtBlock: trigger.blockNumber,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: next.priceDifference,
      // Persist the EFFECTIVE threshold the breach predicate was scored
      // against (`isInDeviationBreach` reads `effectiveThreshold(pool)`).
      // For an asymmetric pool currently on its zero-threshold side
      // (`above=300, below=0` with reserves picking the below side, or
      // mirrored), `next.rebalanceThreshold === 0` while the predicate
      // scored against the 10000-bps fallback — capturing the raw 0
      // would let the heal at line ~270 swap it to the OPPOSITE side's
      // active threshold (300) once reserves flip, retroactively
      // re-scoring `peakPriceDifference` and `criticalDurationSeconds`
      // against a threshold that wasn't in force when the breach opened.
      // `breachEntryThreshold` also gates the 1e12 never-rebalance
      // sentinel out of this `Int!`-typed write — never-rebalance pools
      // can't reach this code path anyway (`isInDeviationBreach`
      // short-circuits them), but keep the conversion defensive.
      entryRebalanceThreshold: breachEntryThreshold(next),
      peakPriceDifference: next.priceDifference,
      peakAt: trigger.blockTimestamp,
      peakAtBlock: trigger.blockNumber,
      startedByEvent: category,
      startedByTxHash: trigger.txHash,
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      // A rebalance transaction that ALSO crossed the threshold upward is
      // extremely unlikely (rebalances typically reduce priceDifference),
      // but count it if it happens — it's still an attempt observed.
      rebalanceCountDuring: isRebalance ? 1 : 0,
    };
    context.DeviationThresholdBreach.set(row);
    return {};
  }

  // Falling edge -----------------------------------------------------------
  if (wasBreached && !isBreached) {
    if (!prev) return {};
    // The row's id is keyed on the rising-edge anchor, which lives on
    // `prev.deviationBreachStartedAt` by construction.
    const openId = openBreachId(poolId, prev.deviationBreachStartedAt);
    const open = await context.DeviationThresholdBreach.get(openId);
    if (!open) {
      // Self-heal case: `nextDeviationBreachStartedAt` adopted the anchor
      // from a partial-restore state (prev was breached with 0n anchor).
      // No rising-edge row was ever recorded, so we can't close one. Roll
      // the cumulative count but skip the duration math — we don't know
      // when the breach actually started.
      return { breachCount: next.breachCount + 1 };
    }
    const endedAt = trigger.blockTimestamp;
    const durationSeconds = tradingSecondsInRange(open.startedAt, endedAt);
    const graceEnd = open.startedAt + DEVIATION_BREACH_GRACE_SECONDS;
    // Critical seconds accrue only when the breach's peak crossed the 5%
    // critical-magnitude line, scored against the threshold captured at
    // RISING EDGE — not the current threshold. Otherwise an
    // FPMMRebalanceThresholdUpdated event mid-breach would retroactively
    // re-score severity, inflating or zeroing the accrual.
    //
    // Fallback chain (PR 1.6 — codex P2 #3214513401, cursor #3214689033):
    //   1. `prev.currentOpenBreachEntryThreshold` (Pool denorm, captured
    //      at rising edge as `breachEntryThreshold(next)`).
    //   2. `open.entryRebalanceThreshold` (entity row captured the same).
    //   3. **10000 floor** — pre-PR-1.6 legacy rows have
    //      `entryRebalanceThreshold=0` because the prior code captured the
    //      raw active threshold and didn't substitute the 10000 fallback
    //      for asymmetric-zero pools. `effectiveThreshold(next)` would
    //      consult the LIVE active side, which can have flipped from 0 to
    //      a positive value (asymmetric reserve direction change), letting
    //      a peak that was non-critical at rising edge re-score as critical
    //      at close. Canonicalize legacy `0` to `10000` — the same
    //      under-bound the predicate scored against at rising edge for any
    //      pool that could have legitimately captured `entry=0`.
    //
    // Conservative bound: time-resolved magnitude isn't tracked, so a breach
    // that briefly hit 1.05+ then dropped will still credit post-grace seconds.
    const LEGACY_ENTRY_THRESHOLD_FLOOR = 10000;
    const healedEntryThreshold =
      (prev?.currentOpenBreachEntryThreshold ?? 0) > 0
        ? prev!.currentOpenBreachEntryThreshold
        : open.entryRebalanceThreshold > 0
          ? open.entryRebalanceThreshold
          : LEGACY_ENTRY_THRESHOLD_FLOOR;
    const peakAboveCritical = isAboveCriticalMagnitude(
      open.peakPriceDifference,
      effectiveThreshold({ rebalanceThreshold: healedEntryThreshold }),
    );
    const criticalDurationSeconds =
      peakAboveCritical && endedAt > graceEnd
        ? tradingSecondsInRange(graceEnd, endedAt)
        : 0n;
    const rebalanceCountDuring =
      open.rebalanceCountDuring + (isRebalance ? 1 : 0);
    const closed: DeviationThresholdBreach = {
      ...open,
      endedAt,
      endedAtBlock: trigger.blockNumber,
      durationSeconds,
      criticalDurationSeconds,
      endedByEvent: category,
      endedByTxHash: trigger.txHash,
      endedByStrategy: isRebalance ? trigger.strategy : undefined,
      rebalanceCountDuring,
    };
    context.DeviationThresholdBreach.set(closed);
    return {
      cumulativeBreachSeconds: next.cumulativeBreachSeconds + durationSeconds,
      cumulativeCriticalSeconds:
        next.cumulativeCriticalSeconds + criticalDurationSeconds,
      breachCount: next.breachCount + 1,
    };
  }

  // Continuing breach ------------------------------------------------------
  // wasBreached && isBreached — maybe bump peak or rebalance count.
  if (!prev) return {};
  const openId = openBreachId(poolId, prev.deviationBreachStartedAt);
  const open = await context.DeviationThresholdBreach.get(openId);
  if (!open) {
    // Self-heal case: `nextDeviationBreachStartedAt` adopted the current
    // block as the anchor for a breach that was already in progress
    // before tracking began. Bootstrap an entity row now so the eventual
    // falling edge has something to close. `startedByEvent` is marked
    // "unknown" because the original trigger is lost.
    context.DeviationThresholdBreach.set({
      id: openBreachId(poolId, next.deviationBreachStartedAt),
      chainId: next.chainId,
      poolId,
      startedAt: next.deviationBreachStartedAt,
      startedAtBlock: trigger.blockNumber,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: next.priceDifference,
      // See rising-edge case above for `breachEntryThreshold` rationale —
      // identical reasoning applies to the bootstrap path.
      entryRebalanceThreshold: breachEntryThreshold(next),
      peakPriceDifference: next.priceDifference,
      peakAt: trigger.blockTimestamp,
      peakAtBlock: trigger.blockNumber,
      startedByEvent: "unknown",
      startedByTxHash: trigger.txHash,
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: isRebalance ? 1 : 0,
    });
    return {};
  }
  const peakBumped = next.priceDifference > open.peakPriceDifference;
  // Attribution upgrade: the FPMM contract emits `ReservesUpdated` inside
  // the swap/mint/burn flow, so the UpdateReserves handler fires first and
  // creates the row with "unknown". Let a subsequent semantic handler in
  // the same tx rewrite the cause so the UI shows "Swap" instead.
  const upgradeCause =
    open.startedByEvent === "unknown" && category !== "unknown";
  // Entry-threshold heal RETIRED (PR 1.6, codex P2 #3214513401):
  //
  // Pre-PR-1.6 the rising edge captured `next.rebalanceThreshold` raw.
  // Asymmetric pools currently on their zero-threshold side persisted
  // entry=0 and the predicate was scored against the 10000-bps fallback.
  // The original heal then swapped that 0 to whatever `next.rebalanceThreshold`
  // resolved to mid-breach — which, after a reserve flip, is the OPPOSITE
  // side's active value. That re-scored `peakPriceDifference` and
  // `criticalDurationSeconds` against a threshold that was never in force
  // when the breach opened, corrupting peak % and critical-duration history.
  //
  // PR 1.6 captures `breachEntryThreshold(next)` at rising edge — always > 0
  // unless never-rebalance (which can't enter breach via `isInDeviationBreach`'s
  // short-circuit). So new breach rows never have `entryRebalanceThreshold === 0`
  // and the heal would never legitimately fire. Old pre-PR-1.6 rows that DO
  // have entry=0 stay at 0: writing the current side's value would still
  // mislead, and the falling-edge fallback chain (`prev.currentOpenBreachEntryThreshold`
  // → `open.entryRebalanceThreshold` → `next.rebalanceThreshold` → 10000) still
  // produces a usable threshold for the close-time `criticalDurationSeconds`
  // accrual.
  if (!peakBumped && !isRebalance && !upgradeCause) return {};
  context.DeviationThresholdBreach.set({
    ...open,
    ...(peakBumped && {
      peakPriceDifference: next.priceDifference,
      peakAt: trigger.blockTimestamp,
      peakAtBlock: trigger.blockNumber,
    }),
    ...(upgradeCause && {
      startedByEvent: category,
      startedByTxHash: trigger.txHash,
    }),
    rebalanceCountDuring: isRebalance
      ? open.rebalanceCountDuring + 1
      : open.rebalanceCountDuring,
  });
  return {};
}
