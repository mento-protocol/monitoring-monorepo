// ---------------------------------------------------------------------------
// Pool and PoolSnapshot upsert logic, health status computation
// ---------------------------------------------------------------------------

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
import { fetchReferenceRateFeedID, fetchReportExpiry, fetchFees } from "./rpc";
import { recordBreachTransition } from "./deviationBreach";

// ---------------------------------------------------------------------------
// Health status computation
// ---------------------------------------------------------------------------

/**
 * How long a pool may sit above the rebalance threshold before the status
 * escalates from WARN to CRITICAL. Mirrors `DEVIATION_BREACH_GRACE_SECONDS`
 * in `ui-dashboard/src/lib/health.ts`.
 */
export const DEVIATION_BREACH_GRACE_SECONDS = 3600n;

/**
 * This indexer branch MUST stay in lockstep with the dashboard's deviation
 * + grace logic in `ui-dashboard/src/lib/health.ts`. Mirrored cases live in
 * `test/healthStatusParity.test.ts`:
 *  - `devRatio <= 1.0` → OK (close-to-threshold is not actionable)
 *  - `devRatio > 1.0` within DEVIATION_BREACH_GRACE_SECONDS → WARN
 *  - `devRatio > 1.0` beyond the grace → CRITICAL
 *
 * Grace is anchored on `deviationBreachStartedAt`, which the caller updates
 * BEFORE invoking this function so `pool.deviationBreachStartedAt` reflects
 * the current row's breach start (not the previous one).
 *
 * Intentional divergences (NOT covered by the parity suite):
 *  - Oracle staleness: indexer reads the event-time `oracleOk` flag;
 *    the UI reads `oracleTimestamp` + `oracleExpiry` against wall clock
 *    at render time with per-chain fallbacks.
 *  - Weekend reclassification: only the UI has `isWeekend()` at render
 *    time. Indexed weekend-stale pools surface as CRITICAL here; the UI
 *    reclassifies them to WEEKEND when rendering.
 */
export function computeHealthStatus(pool: Pool, nowSeconds: bigint): string {
  if (pool.source.includes("virtual")) return "N/A";
  if (!pool.oracleOk) return "CRITICAL";
  const threshold =
    pool.rebalanceThreshold > 0 ? pool.rebalanceThreshold : 10000;
  const devRatio = Number(pool.priceDifference) / threshold;
  if (devRatio > 1.0) {
    // Without a breach-start anchor (indexer hasn't populated it yet), stay
    // at WARN rather than spuriously escalating to CRITICAL.
    if (pool.deviationBreachStartedAt <= 0n) return "WARN";
    const withinGrace =
      nowSeconds - pool.deviationBreachStartedAt <
      DEVIATION_BREACH_GRACE_SECONDS;
    return withinGrace ? "WARN" : "CRITICAL";
  }
  return "OK";
}

// Integer comparison avoids float pathology at the devRatio = 1.0 boundary.
// Strict `>` matches `computeHealthStatus`: exactly-at-threshold stays OK,
// so it is NOT counted as a breach either. Oracle staleness is
// intentionally NOT counted — this tracks price action only.
export function isInDeviationBreach(pool: Pool): boolean {
  if (pool.source.includes("virtual")) return false;
  const threshold =
    pool.rebalanceThreshold > 0 ? pool.rebalanceThreshold : 10000;
  return pool.priceDifference > BigInt(threshold);
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

// ---------------------------------------------------------------------------
// Pool upsert (with cumulative fields)
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY = {
  virtual_pool_factory: 100,
  fpmm_factory: 90,
  fpmm_rebalanced: 50,
  fpmm_update_reserves: 40,
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
  Pool: {
    get: (id: string) => Promise<Pool | undefined>;
    set: (entity: Pool) => void;
  };
  DeviationThresholdBreach: {
    get: (id: string) => Promise<DeviationThresholdBreach | undefined>;
    set: (entity: DeviationThresholdBreach) => void;
  };
};

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
  invertRateFeed: false,
  priceDifference: 0n,
  rebalanceThreshold: 0,
  lastRebalancedAt: 0n,
  deviationBreachStartedAt: 0n,
  healthStatus: "N/A" as string,
  limitStatus: "N/A" as string,
  limitPressure0: "0.0000" as string,
  limitPressure1: "0.0000" as string,
  lpFee: -1,
  protocolFee: -1,
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
  txHash,
  strategy,
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
    !existing.source.includes("virtual")
  ) {
    const rateFeedID = await fetchReferenceRateFeedID(chainId, poolAddr);
    if (rateFeedID) {
      healedOracleDelta = { referenceRateFeedID: rateFeedID };
      const expiry = await fetchReportExpiry(chainId, rateFeedID, blockNumber);
      if (expiry !== null) healedOracleDelta.oracleExpiry = expiry;
    }
  }

  // Self-heal: if fees are still at the -1 sentinel (deploy-time RPC read
  // failed), retry now. Once we get a successful read — even if the real
  // fees are 0 — we persist the result and stop retrying.
  let healedFees: { lpFee: number; protocolFee: number } | undefined;
  if (
    (existing.lpFee < 0 || existing.protocolFee < 0) &&
    existing.source !== "" &&
    !existing.source.includes("virtual")
  ) {
    const fees = await fetchFees(chainId, poolAddr);
    if (fees) {
      healedFees = fees;
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
    : !next.source.includes("virtual") && next.oraclePrice > 0n
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
  const withBreach = { ...withDeviation, deviationBreachStartedAt };
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
        blockNumber,
      };

  context.PoolDailySnapshot.set(snapshot);
};
