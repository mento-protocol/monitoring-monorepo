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

/** Safety cap for carry-forward duration (1 hour) */
const MAX_CARRY_SECONDS = 3600n;

/** Fixed decimal precision for ratio strings */
const PRECISION = 6;

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
    return {
      deviationRatio: "0.000000",
      healthBinaryValue: "1.000000",
      hasHealthData: false,
    };
  }

  const d = Number(priceDifference) / rebalanceThreshold;
  const deviationRatio = d.toFixed(PRECISION);
  const healthBinaryValue = d <= 1.0 ? "1.000000" : "0.000000";

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

  // Normal case: positive duration interval
  const duration = currentTimestamp - lastTs;

  // Freshness limit = min(pool.oracleExpiry, MAX_CARRY_SECONDS)
  // oracleExpiry of 0 means unknown — fall back to MAX_CARRY_SECONDS
  const oracleExpiry =
    pool.oracleExpiry > 0n ? pool.oracleExpiry : MAX_CARRY_SECONDS;
  const freshnessLimit =
    oracleExpiry < MAX_CARRY_SECONDS ? oracleExpiry : MAX_CARRY_SECONDS;

  // Split: carry segment + stale segment
  const carrySeconds = duration <= freshnessLimit ? duration : freshnessLimit;
  // staleSeconds = duration - carrySeconds (always unhealthy, h=0)

  // Was the PREVIOUS interval healthy? (deviationRatio of the previous snapshot)
  const prevD = parseFloat(pool.lastDeviationRatio);
  const prevHealthy = !isNaN(prevD) && prevD <= 1.0;

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

  const poolUpdate = updateHealthAccumulators(
    pool,
    blockTimestamp,
    snapshotFields.deviationRatio,
  );

  return { snapshotFields, poolUpdate };
}
