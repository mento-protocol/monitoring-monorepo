// ---------------------------------------------------------------------------
// Pool and PoolSnapshot upsert logic, health status computation
// ---------------------------------------------------------------------------

import type { Pool, PoolSnapshot } from "generated";
import { hourBucket, snapshotId, extractAddressFromPoolId } from "./helpers";
import { computePriceDifference } from "./priceDifference";
import { fetchReferenceRateFeedID, fetchReportExpiry } from "./rpc";

// ---------------------------------------------------------------------------
// Health status computation
// ---------------------------------------------------------------------------

/**
 * Grace window for a deviation breach before it escalates to CRITICAL.
 * Mirrors `DEVIATION_BREACH_GRACE_SECONDS` in
 * `ui-dashboard/src/lib/health.ts`. Cross-chain rebalances take minutes
 * to confirm; if a rebalance landed within this window, we stay at WARN
 * rather than flagging an incident.
 */
export const DEVIATION_BREACH_GRACE_SECONDS = 3600n;

/**
 * MUST stay in lockstep with `computeHealthStatus` in
 * `ui-dashboard/src/lib/health.ts`. Parity cases live in
 * `test/healthStatusParity.test.ts` and
 * `ui-dashboard/src/lib/__tests__/health.test.ts`.
 *
 * Key boundaries:
 *  - `devRatio > 1.0` → CRITICAL (strict; exactly-at-threshold stays WARN)
 *  - Breach + rebalance within DEVIATION_BREACH_GRACE_SECONDS → WARN
 *
 * The indexer has no wall-clock `isWeekend()` at event time (batch
 * processing historical blocks), so the WEEKEND status is produced only
 * by the UI at render time. Indexed weekend-stale pools surface as
 * CRITICAL here; the UI reclassifies them when rendering.
 */
export function computeHealthStatus(pool: Pool, nowSeconds: bigint): string {
  if (pool.source?.includes("virtual")) return "N/A";
  if (!pool.oracleOk) return "CRITICAL";
  const threshold =
    pool.rebalanceThreshold > 0 ? pool.rebalanceThreshold : 10000;
  const devRatio = Number(pool.priceDifference) / threshold;
  if (devRatio > 1.0) {
    const withinGrace =
      pool.lastRebalancedAt > 0n &&
      nowSeconds - pool.lastRebalancedAt < DEVIATION_BREACH_GRACE_SECONDS;
    return withinGrace ? "WARN" : "CRITICAL";
  }
  if (devRatio >= 0.8) return "WARN";
  return "OK";
}

// ---------------------------------------------------------------------------
// Pool upsert (with cumulative fields)
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY: Record<string, number> = {
  virtual_pool_factory: 100,
  fpmm_factory: 90,
  fpmm_rebalanced: 50,
  fpmm_update_reserves: 40,
  fpmm_swap: 30,
  fpmm_mint: 20,
  fpmm_burn: 20,
};

const pickPreferredSource = (
  existingSource: string | undefined,
  incomingSource: string,
): string => {
  if (!existingSource) return incomingSource;
  const existingPriority = SOURCE_PRIORITY[existingSource] ?? 0;
  const incomingPriority = SOURCE_PRIORITY[incomingSource] ?? 0;
  return incomingPriority >= existingPriority ? incomingSource : existingSource;
};

export type PoolContext = {
  Pool: {
    get: (id: string) => Promise<Pool | undefined>;
    set: (entity: Pool) => void;
  };
};

export type SnapshotContext = {
  PoolSnapshot: {
    get: (id: string) => Promise<PoolSnapshot | undefined>;
    set: (entity: PoolSnapshot) => void;
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
  invertRateFeed: false,
  priceDifference: 0n,
  rebalanceThreshold: 0,
  lastRebalancedAt: 0n,
  healthStatus: "N/A" as string,
  limitStatus: "N/A" as string,
  limitPressure0: "0.0000" as string,
  limitPressure1: "0.0000" as string,
  rebalancerAddress: "" as string,
  rebalanceLivenessStatus: "N/A" as string,
  token0Decimals: 18,
  token1Decimals: 18,
  // Health score accumulators
  healthTotalSeconds: 0n,
  healthBinarySeconds: 0n,
  lastOracleSnapshotTimestamp: 0n,
  lastDeviationRatio: "-1",
  hasHealthData: false,
};

const getOrCreatePool = async (
  context: PoolContext,
  chainId: number,
  poolId: string,
  defaults?: { token0?: string; token1?: string },
): Promise<Pool> => {
  const existing = await context.Pool.get(poolId);
  if (existing) return existing;
  return {
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
  };
};

export const upsertPool = async ({
  context,
  chainId,
  poolId,
  token0,
  token1,
  source,
  blockNumber,
  blockTimestamp,
  reservesDelta,
  swapDelta,
  rebalanceDelta,
  oracleDelta,
  tokenDecimals,
}: {
  context: PoolContext;
  chainId: number;
  poolId: string;
  token0?: string;
  token1?: string;
  source: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  reservesDelta?: { reserve0: bigint; reserve1: bigint };
  swapDelta?: { volume0: bigint; volume1: bigint };
  rebalanceDelta?: boolean;
  oracleDelta?: Partial<typeof DEFAULT_ORACLE_FIELDS>;
  tokenDecimals?: { token0Decimals: number; token1Decimals: number };
}): Promise<Pool> => {
  const existing = await getOrCreatePool(context, chainId, poolId, {
    token0,
    token1,
  });

  // Self-heal: if referenceRateFeedID is missing (transient RPC failure at
  // pool creation), retry now so oracle events can start flowing.
  // Use the raw address (not the namespaced poolId) for RPC calls.
  const poolAddr = extractAddressFromPoolId(poolId);
  let healedOracleDelta: Partial<typeof DEFAULT_ORACLE_FIELDS> | undefined;
  if (
    existing.referenceRateFeedID === "" &&
    existing.source !== "" &&
    !existing.source?.includes("virtual")
  ) {
    const rateFeedID = await fetchReferenceRateFeedID(chainId, poolAddr);
    if (rateFeedID) {
      healedOracleDelta = { referenceRateFeedID: rateFeedID };
      const expiry = await fetchReportExpiry(chainId, rateFeedID, blockNumber);
      if (expiry !== null) healedOracleDelta.oracleExpiry = expiry;
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
    // Merge healed oracle fields first, then explicit delta takes precedence
    ...(healedOracleDelta ?? {}),
    ...(oracleDelta ?? {}),
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
    : !next.source?.includes("virtual") && next.oraclePrice > 0n
      ? computePriceDifference(next)
      : next.priceDifference;

  const withDeviation = { ...next, priceDifference };
  const healthStatus = computeHealthStatus(withDeviation, blockTimestamp);
  const final = { ...withDeviation, healthStatus };

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
};
