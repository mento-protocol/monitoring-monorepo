// Pure pool-merge helpers for fetchNetworkData's isolated per-source queries.
// Each function folds one Promise.allSettled result into `pools` by id; on
// `rejected` the pools pass through unchanged so a single schema-lag failure
// only drops that source's fields, not the whole pool list.

import type { Pool } from "@/lib/types";
import { mergeDeprecatedVirtualPools } from "./vp-deprecation";
import type { NetworkSources } from "./sources";
import type {
  PoolBreachRollupResult,
  PoolHealthCursorResult,
  PoolRebalanceThresholdsKnownResult,
  PoolsVpOracleFreshnessResult,
} from "./types";

/** Merges uptime rollup fields (breachCount / health seconds) into `pools`. */
function mergeBreachRollup(
  pools: Pool[],
  result: PromiseSettledResult<PoolBreachRollupResult>,
): Pool[] {
  if (result.status !== "fulfilled") return pools;
  const rollupById = new Map((result.value.Pool ?? []).map((r) => [r.id, r]));
  return pools.map((p) => {
    const r = rollupById.get(p.id);
    return r == null
      ? p
      : {
          ...p,
          breachCount: r.breachCount,
          healthBinarySeconds: r.healthBinarySeconds,
          // BOTH fields come from the rollup so the numerator/denominator
          // pair is a same-query snapshot — no falling back to
          // ALL_POOLS_WITH_HEALTH's `healthTotalSeconds`, which would
          // pair counters captured at different polling cycles.
          healthTotalSeconds: r.healthTotalSeconds,
        };
  });
}

/** Merges live-tail cursor fields (oracle snapshot timestamp / deviation). */
function mergeHealthCursor(
  pools: Pool[],
  result: PromiseSettledResult<PoolHealthCursorResult>,
): Pool[] {
  if (result.status !== "fulfilled") return pools;
  const cursorById = new Map((result.value.Pool ?? []).map((r) => [r.id, r]));
  return pools.map((p) => {
    const r = cursorById.get(p.id);
    return r == null
      ? p
      : {
          ...p,
          lastOracleSnapshotTimestamp: r.lastOracleSnapshotTimestamp,
          lastDeviationRatio: r.lastDeviationRatio,
        };
  });
}

/** Merges rebalance-threshold / degenerate-classification flags. */
function mergeRebalanceThresholdsKnown(
  pools: Pool[],
  result: PromiseSettledResult<PoolRebalanceThresholdsKnownResult>,
): Pool[] {
  if (result.status !== "fulfilled") return pools;
  const knownById = new Map((result.value.Pool ?? []).map((r) => [r.id, r]));
  return pools.map((p) => {
    const r = knownById.get(p.id);
    return r == null
      ? p
      : {
          ...p,
          rebalanceThresholdAbove: r.rebalanceThresholdAbove,
          rebalanceThresholdBelow: r.rebalanceThresholdBelow,
          rebalanceThresholdsKnown: r.rebalanceThresholdsKnown,
          tokenDecimalsKnown: r.tokenDecimalsKnown,
          degenerateReserves: r.degenerateReserves,
          breakerTripped: r.breakerTripped,
        };
  });
}

/** Merges VP oracle-freshness fields (staleness state). */
function mergeVpOracleFreshness(
  pools: Pool[],
  result: PromiseSettledResult<PoolsVpOracleFreshnessResult>,
): Pool[] {
  if (result.status !== "fulfilled") return pools;
  const freshnessById = new Map(
    (result.value.Pool ?? []).map((r) => [r.id, r]),
  );
  return pools.map((p) => {
    const r = freshnessById.get(p.id);
    return r == null
      ? p
      : {
          ...p,
          lastOracleReportAt: r.lastOracleReportAt,
          medianLive: r.medianLive,
          oracleFreshnessWindow: r.oracleFreshnessWindow,
        };
  });
}

/**
 * Applies every isolated per-source merge, in order, plus the VP-deprecation
 * merge (owned by `./vp-deprecation`). On any individual source's rejection
 * that source's fields simply stay undefined on the affected pools.
 */
export function mergePoolSources(
  pools: Pool[],
  sources: Pick<
    NetworkSources,
    | "breachRollup"
    | "healthCursor"
    | "rebalanceThresholdsKnown"
    | "vpOracleFreshness"
    | "vpDeprecation"
    | "vpLifecycleDeprecation"
  >,
): Pool[] {
  let merged = mergeBreachRollup(pools, sources.breachRollup);
  merged = mergeHealthCursor(merged, sources.healthCursor);
  merged = mergeRebalanceThresholdsKnown(
    merged,
    sources.rebalanceThresholdsKnown,
  );
  merged = mergeVpOracleFreshness(merged, sources.vpOracleFreshness);
  return mergeDeprecatedVirtualPools(
    merged,
    sources.vpDeprecation.status === "fulfilled"
      ? (sources.vpDeprecation.value.BiPoolExchange ?? [])
      : [],
    sources.vpLifecycleDeprecation.status === "fulfilled"
      ? (sources.vpLifecycleDeprecation.value.VirtualPoolLifecycle ?? [])
      : [],
  );
}
