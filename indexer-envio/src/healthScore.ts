// ---------------------------------------------------------------------------
// Health Score — binary "availability" metric per pool
// ---------------------------------------------------------------------------
//
// Computes deviationRatio and binary health value per oracle snapshot,
// and accumulates all-time health seconds on the Pool entity.
//
// deviationRatio = priceDifference / rebalanceThreshold
// Binary: d ≤ 1.0 → healthy (1), d > 1.0 → unhealthy (0)
//
// Gap handling between oracle snapshots:
//   - Gap ≤ freshnessLimit: carry last known state
//   - Gap > freshnessLimit: first freshnessLimit seconds carry last state,
//     remaining seconds are treated as unhealthy (stale)
//   - freshnessLimit = min(pool.oracleExpiry, MAX_CARRY_SECONDS)
// ---------------------------------------------------------------------------

import type { Pool, OracleSnapshot } from "generated";
import FX_CALENDAR from "../config/fx-calendar.json";

/** Safety cap for carry-forward duration (1 hour) */
const MAX_CARRY_SECONDS = 3600n;

/** Fixed decimal precision for ratio strings */
const PRECISION = 6;

// ---------------------------------------------------------------------------
// Trading-second arithmetic: subtract FX weekend overlap from durations so
// weekends are excluded from both numerator and denominator of the all-time
// health score. Half-open semantics: Fri 21:00 UTC inclusive, Sun 23:00 UTC
// exclusive. Constants come from config/fx-calendar.json (vendored copy of
// shared-config/fx-calendar.json — Envio builds outside the pnpm workspace, so
// the indexer can't depend on the shared package directly). The sync test at
// test/fx-calendar.test.ts keeps the two files from drifting apart.
// ---------------------------------------------------------------------------

/** Fri 2024-01-05 21:00:00 UTC — anchor for the 7-day weekend cycle. */
const ANCHOR_FRI_2100 = BigInt(FX_CALENDAR.anchorFri2100UnixSec);
const WEEK_SECONDS = 7n * 24n * 3600n;
/** Derived from all four calendar fields so the weekend arithmetic stays
 * in lockstep with isWeekend() on the UI side. For Fri 21:00 → Sun 23:00
 * this evaluates to 50h (180000s). */
const WEEKEND_DURATION_SECONDS = BigInt(
  ((FX_CALENDAR.fxReopenDay - FX_CALENDAR.fxCloseDay + 7) % 7) * 86400 +
    (FX_CALENDAR.fxReopenHourUtc - FX_CALENDAR.fxCloseHourUtc) * 3600,
);

/**
 * Seconds in [startTs, endTs) that fall inside FX weekend windows.
 * Closed-form, one iteration per overlapping week.
 */
function weekendOverlapSeconds(startTs: bigint, endTs: bigint): bigint {
  if (endTs <= startTs) return 0n;
  let total = 0n;
  // BigInt `/` truncates toward zero; adjust for negative non-exact offsets
  // so k floors toward -∞ (weekends before the anchor enumerate correctly).
  const offset = startTs - ANCHOR_FRI_2100;
  let k = offset / WEEK_SECONDS;
  if (offset < 0n && offset % WEEK_SECONDS !== 0n) k -= 1n;
  while (true) {
    const wStart = ANCHOR_FRI_2100 + k * WEEK_SECONDS;
    const wEnd = wStart + WEEKEND_DURATION_SECONDS;
    if (wStart >= endTs) break;
    if (wEnd > startTs) {
      const lo = wStart > startTs ? wStart : startTs;
      const hi = wEnd < endTs ? wEnd : endTs;
      total += hi - lo;
    }
    k += 1n;
  }
  return total;
}

/**
 * Seconds in [startTs, endTs) that fall outside FX weekend windows.
 * Used by the accumulator so weekend gaps aren't counted as stale.
 */
export function tradingSecondsInRange(startTs: bigint, endTs: bigint): bigint {
  if (endTs <= startTs) return 0n;
  return endTs - startTs - weekendOverlapSeconds(startTs, endTs);
}

// ---------------------------------------------------------------------------
// Pure computation: per-snapshot fields
// ---------------------------------------------------------------------------

export interface HealthSnapshotFields {
  deviationRatio: string;
  healthBinaryValue: string;
  hasHealthData: boolean;
}

/**
 * Compute health fields for an oracle snapshot.
 *
 * @param priceDifference — raw priceDifference from pool/event (BigInt)
 * @param rebalanceThreshold — pool's rebalanceThreshold (integer)
 * @returns health fields to merge into the OracleSnapshot entity
 */
export function computeHealthSnapshotFields(
  priceDifference: bigint,
  rebalanceThreshold: number,
): HealthSnapshotFields {
  if (rebalanceThreshold <= 0) {
    // No-data sentinel: use "-1" for deviationRatio and "0.000000" for
    // healthBinaryValue so consumers can't accidentally treat this as healthy.
    // hasHealthData=false is the canonical gate — check it before using values.
    return {
      deviationRatio: "-1",
      healthBinaryValue: "0.000000",
      hasHealthData: false,
    };
  }

  // Use integer comparison for the binary threshold to avoid float precision
  // issues at the d=1.0 boundary (e.g. priceDifference=5000, threshold=5000).
  const isHealthy = priceDifference <= BigInt(rebalanceThreshold);
  // Compute deviationRatio using bigint arithmetic to avoid Number() precision
  // loss for large priceDifference values (>2^53 would corrupt float conversion).
  // Scale numerator by 10^PRECISION before dividing, then format as fixed decimal.
  const SCALE = BigInt(10 ** PRECISION);
  const threshold = BigInt(rebalanceThreshold);
  const scaledRatio = (priceDifference * SCALE) / threshold;
  const intPart = scaledRatio / SCALE;
  const fracPart = scaledRatio % SCALE;
  const deviationRatio = `${intPart}.${fracPart.toString().padStart(PRECISION, "0")}`;
  const healthBinaryValue = isHealthy ? "1.000000" : "0.000000";

  return { deviationRatio, healthBinaryValue, hasHealthData: true };
}

// ---------------------------------------------------------------------------
// Pool accumulator update
// ---------------------------------------------------------------------------

export interface HealthAccumulatorUpdate {
  healthTotalSeconds: bigint;
  healthBinarySeconds: bigint;
  lastOracleSnapshotTimestamp: bigint;
  lastDeviationRatio: string;
  hasHealthData: boolean;
}

/**
 * Finalize the interval since the last oracle snapshot and update accumulators.
 *
 * This function implements the gap-split logic:
 *   1. If no previous snapshot (lastOracleSnapshotTimestamp === 0), just set
 *      the current state — no duration to accumulate.
 *   2. If currentTimestamp <= lastTimestamp (same-block events), update state
 *      but don't accumulate duration (zero-duration interval).
 *   3. Otherwise, compute interval duration and split by freshness limit.
 *
 * @param pool — current Pool entity (with existing accumulators)
 * @param currentTimestamp — block timestamp of the new oracle event
 * @param currentDeviationRatio — deviationRatio string for the new snapshot
 */
export function updateHealthAccumulators(
  pool: Pool,
  currentTimestamp: bigint,
  currentDeviationRatio: string,
): HealthAccumulatorUpdate {
  const lastTs = pool.lastOracleSnapshotTimestamp;

  // First ever snapshot for this pool — initialize, no duration to add
  if (lastTs === 0n) {
    return {
      healthTotalSeconds: pool.healthTotalSeconds,
      healthBinarySeconds: pool.healthBinarySeconds,
      lastOracleSnapshotTimestamp: currentTimestamp,
      lastDeviationRatio: currentDeviationRatio,
      hasHealthData: true,
    };
  }

  // Same-block / same-timestamp event — update state, no duration
  if (currentTimestamp <= lastTs) {
    return {
      healthTotalSeconds: pool.healthTotalSeconds,
      healthBinarySeconds: pool.healthBinarySeconds,
      lastOracleSnapshotTimestamp: lastTs, // keep the earlier timestamp
      lastDeviationRatio: currentDeviationRatio,
      hasHealthData: true,
    };
  }

  // Normal case: positive duration interval.
  // Measure in trading-seconds so FX weekend wall-clock time is excluded
  // from both numerator and denominator (matches UI computeBinaryHealthWindow).
  const duration = tradingSecondsInRange(lastTs, currentTimestamp);

  // Match UI computeBinaryHealthWindow: freshness is wall-clock (a snapshot
  // expires at a wall-clock moment regardless of weekend), then the carry
  // range is measured in trading-seconds.
  // oracleExpiry of 0 means unknown — fall back to MAX_CARRY_SECONDS.
  const oracleExpiry =
    pool.oracleExpiry > 0n ? pool.oracleExpiry : MAX_CARRY_SECONDS;
  const freshnessLimit =
    oracleExpiry < MAX_CARRY_SECONDS ? oracleExpiry : MAX_CARRY_SECONDS;
  const freshnessEnd = lastTs + freshnessLimit;
  const carryEnd =
    currentTimestamp < freshnessEnd ? currentTimestamp : freshnessEnd;
  const carrySeconds = tradingSecondsInRange(lastTs, carryEnd);
  // duration is already trading-seconds; so is carrySeconds. stale = duration - carry.

  // Was the PREVIOUS interval healthy?
  // Use string comparison against sentinel to avoid float boundary issues.
  // lastDeviationRatio is "-1" for no-data, or a 6dp decimal string.
  const prevRatio = pool.lastDeviationRatio;
  const prevIsNoData = prevRatio === "-1" || prevRatio === "";
  const prevHealthy =
    !prevIsNoData &&
    parseFloat(prevRatio) <= 1.0 &&
    !isNaN(parseFloat(prevRatio));

  // If previous interval was no-data, exclude this duration from the
  // denominator entirely — matching UI which skips hasHealthData=false segments.
  if (prevIsNoData) {
    return {
      healthTotalSeconds: pool.healthTotalSeconds,
      healthBinarySeconds: pool.healthBinarySeconds,
      lastOracleSnapshotTimestamp: currentTimestamp,
      lastDeviationRatio: currentDeviationRatio,
      hasHealthData: true,
    };
  }

  let newTotalSeconds = pool.healthTotalSeconds + duration;
  let newBinarySeconds = pool.healthBinarySeconds;

  if (prevHealthy) {
    // Previous state was healthy: carry segment counts as healthy
    newBinarySeconds += carrySeconds;
    // Stale segment (if any) is unhealthy → adds 0 to binarySeconds
  }
  // If previous state was unhealthy: neither carry nor stale adds to binarySeconds

  return {
    healthTotalSeconds: newTotalSeconds,
    healthBinarySeconds: newBinarySeconds,
    lastOracleSnapshotTimestamp: currentTimestamp,
    lastDeviationRatio: currentDeviationRatio,
    hasHealthData: true,
  };
}

// ---------------------------------------------------------------------------
// Combined helper: compute snapshot fields + update pool accumulators
// ---------------------------------------------------------------------------

export interface RecordHealthSampleResult {
  snapshotFields: HealthSnapshotFields;
  poolUpdate: HealthAccumulatorUpdate;
}

/**
 * Single entry point for recording a health sample. Called by both
 * SortedOracles and FPMM handlers when writing an OracleSnapshot.
 *
 * @param pool — current Pool entity
 * @param priceDifference — from event/pool
 * @param rebalanceThreshold — from pool
 * @param blockTimestamp — block timestamp of the event
 */
export function recordHealthSample(
  pool: Pool,
  priceDifference: bigint,
  rebalanceThreshold: number,
  blockTimestamp: bigint,
): RecordHealthSampleResult {
  const snapshotFields = computeHealthSnapshotFields(
    priceDifference,
    rebalanceThreshold,
  );

  // If snapshot has no valid health data (e.g. rebalanceThreshold <= 0),
  // don't add to accumulators but DO advance lastOracleSnapshotTimestamp.
  // This ensures the next valid sample doesn't retroactively accumulate
  // the no-data gap — matching UI semantics which skip these intervals.
  if (!snapshotFields.hasHealthData) {
    return {
      snapshotFields,
      poolUpdate: {
        healthTotalSeconds: pool.healthTotalSeconds,
        healthBinarySeconds: pool.healthBinarySeconds,
        lastOracleSnapshotTimestamp: blockTimestamp,
        lastDeviationRatio: "-1", // sentinel: next sample skips this gap
        hasHealthData: pool.hasHealthData,
      },
    };
  }

  const poolUpdate = updateHealthAccumulators(
    pool,
    blockTimestamp,
    snapshotFields.deviationRatio,
  );

  return { snapshotFields, poolUpdate };
}
