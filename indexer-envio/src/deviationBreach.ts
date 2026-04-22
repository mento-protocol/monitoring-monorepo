// ---------------------------------------------------------------------------
// DeviationThresholdBreach lifecycle
//
// Per-breach history rows. Created on the rising edge (pool crosses
// priceDifference > rebalanceThreshold), updated while open (peak price,
// rebalance attempts), closed on the falling edge with durations measured
// in trading-seconds (FX weekends excluded).
//
// Also rolls the closed-breach durations into two cumulative counters on
// the Pool itself (`cumulativeBreachSeconds`, `cumulativeCriticalSeconds`)
// so the UI can compute all-time uptime % without paginating history.
// ---------------------------------------------------------------------------

import type { Pool, DeviationThresholdBreach } from "generated";
import { isInDeviationBreach, DEVIATION_BREACH_GRACE_SECONDS } from "./pool";
import { tradingSecondsInRange } from "./healthScore";

export type BreachContext = {
  DeviationThresholdBreach: {
    get: (id: string) => Promise<DeviationThresholdBreach | undefined>;
    set: (entity: DeviationThresholdBreach) => void;
  };
};

/** Maps the indexer's internal `source` vocabulary (which tracks WHICH
 * handler fired, regardless of the Pool's sticky preferred-source) to the
 * user-facing event categories stored on `DeviationThresholdBreach`.
 *
 * The `source` argument here is the raw triggering source of the CURRENT
 * event, NOT `pool.source` — the latter is priority-picked and sticky
 * (a factory-created pool stays "fpmm_factory" forever) and so is useless
 * for attributing which event caused a transition. */
export function classifyBreachEvent(source: string): string {
  if (source.includes("virtual")) return "unknown";
  if (source === "fpmm_rebalanced") return "rebalance";
  if (source === "fpmm_swap") return "swap";
  if (source === "fpmm_mint" || source === "fpmm_burn") return "liquidity";
  if (source === "fpmm_update_reserves") return "liquidity";
  if (source === "fpmm_factory") return "threshold_change";
  if (source === "oracle_reported" || source === "median_updated")
    return "oracle_update";
  return "unknown";
}

type TransitionMeta = {
  blockTimestamp: bigint;
  blockNumber: bigint;
  txHash: string;
  /** Triggering event's raw source (see `classifyBreachEvent`). */
  triggeringSource: string;
  /** Strategy contract that fired the rebalance, if this transition was
   * caused by a RebalanceEvent. Ignored otherwise. */
  triggeringStrategy?: string;
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
  meta: TransitionMeta,
): Promise<Partial<Pool>> {
  const wasBreached = prev ? isInDeviationBreach(prev) : false;
  const isBreached = isInDeviationBreach(next);

  if (!wasBreached && !isBreached) return {};

  const poolId = next.id;
  const startedByEvent = classifyBreachEvent(meta.triggeringSource);
  const isRebalance = meta.triggeringSource === "fpmm_rebalanced";

  // Rising edge ------------------------------------------------------------
  if (!wasBreached && isBreached) {
    const row: DeviationThresholdBreach = {
      id: openBreachId(poolId, meta.blockTimestamp),
      chainId: next.chainId,
      poolId,
      startedAt: meta.blockTimestamp,
      startedAtBlock: meta.blockNumber,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: next.priceDifference,
      peakPriceDifference: next.priceDifference,
      peakAt: meta.blockTimestamp,
      peakAtBlock: meta.blockNumber,
      startedByEvent,
      startedByTxHash: meta.txHash,
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
    // prev!.deviationBreachStartedAt was the anchor; the row's id is keyed
    // on that exact value.
    const openId = openBreachId(poolId, prev!.deviationBreachStartedAt);
    const open = await context.DeviationThresholdBreach.get(openId);
    if (!open) {
      // No row to close (data inconsistency, e.g. pool was breached in
      // history but the breach row was lost). Skip gracefully rather than
      // throw — one missing row shouldn't stall the handler.
      return {};
    }
    const endedAt = meta.blockTimestamp;
    const durationSeconds = tradingSecondsInRange(open.startedAt, endedAt);
    const graceEnd = open.startedAt + DEVIATION_BREACH_GRACE_SECONDS;
    const criticalDurationSeconds =
      endedAt > graceEnd ? tradingSecondsInRange(graceEnd, endedAt) : 0n;
    const rebalanceCountDuring =
      open.rebalanceCountDuring + (isRebalance ? 1 : 0);
    const closed: DeviationThresholdBreach = {
      ...open,
      endedAt,
      endedAtBlock: meta.blockNumber,
      durationSeconds,
      criticalDurationSeconds,
      endedByEvent: classifyBreachEvent(meta.triggeringSource),
      endedByTxHash: meta.txHash,
      endedByStrategy: isRebalance ? meta.triggeringStrategy : undefined,
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
  const openId = openBreachId(poolId, prev!.deviationBreachStartedAt);
  const open = await context.DeviationThresholdBreach.get(openId);
  if (!open) return {};
  let dirty = false;
  let updated: DeviationThresholdBreach = open;
  if (next.priceDifference > open.peakPriceDifference) {
    updated = {
      ...updated,
      peakPriceDifference: next.priceDifference,
      peakAt: meta.blockTimestamp,
      peakAtBlock: meta.blockNumber,
    };
    dirty = true;
  }
  if (isRebalance) {
    updated = {
      ...updated,
      rebalanceCountDuring: updated.rebalanceCountDuring + 1,
    };
    dirty = true;
  }
  if (dirty) context.DeviationThresholdBreach.set(updated);
  return {};
}
