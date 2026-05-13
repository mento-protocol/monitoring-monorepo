import type {
  AggregatorDailySnapshot,
  AggregatorTraderDayMarker,
  Pool,
  PoolDailyVolumeSnapshot,
  TraderDailySnapshot,
  TraderPoolDailySnapshot,
  TraderPoolDayMarker,
} from "envio";
import { applyFeeBps } from "./usd.js";
import { isSystemAddress } from "./system-addresses.js";
import { classifyAggregator } from "./aggregators.js";
import { dayBucket, extractAddressFromPoolId } from "./helpers.js";
import {
  maybeHeartbeatFlushV3,
  type V3FlushContext,
} from "./leaderboardWindowFlush.js";

/** Subset of Envio's handler context that the leaderboard snapshot helper
 *  reads/writes. Both the FPMM and VirtualPool swap handlers' contexts are
 *  structurally compatible with this shape. */
export type LeaderboardContext = V3FlushContext & {
  TraderDailySnapshot: {
    get: (id: string) => Promise<TraderDailySnapshot | undefined>;
    set: (entity: TraderDailySnapshot) => void;
  };
  TraderPoolDailySnapshot: {
    get: (id: string) => Promise<TraderPoolDailySnapshot | undefined>;
    set: (entity: TraderPoolDailySnapshot) => void;
  };
  PoolDailyVolumeSnapshot: {
    get: (id: string) => Promise<PoolDailyVolumeSnapshot | undefined>;
    set: (entity: PoolDailyVolumeSnapshot) => void;
  };
  AggregatorDailySnapshot: {
    get: (id: string) => Promise<AggregatorDailySnapshot | undefined>;
    set: (entity: AggregatorDailySnapshot) => void;
  };
  TraderPoolDayMarker: {
    get: (id: string) => Promise<TraderPoolDayMarker | undefined>;
    set: (entity: TraderPoolDayMarker) => void;
  };
  AggregatorTraderDayMarker: {
    get: (id: string) => Promise<AggregatorTraderDayMarker | undefined>;
    set: (entity: AggregatorTraderDayMarker) => void;
  };
};

export interface SwapAmounts {
  amount0In: bigint;
  amount0Out: bigint;
  amount1In: bigint;
  amount1Out: bigint;
}

export interface ApplyLeaderboardSnapshotsArgs {
  context: LeaderboardContext;
  chainId: number;
  poolId: string;
  pool: Pool;
  caller: string; // tx.from, lowercased — the trader key
  txTo: string; // tx.to, lowercased — the entry-point contract for aggregator classification
  volumeUsdWei: bigint; // pre-computed via computeSwapUsdWei (lives on SwapEvent)
  amounts: SwapAmounts;
  blockTimestamp: bigint;
  blockNumber: bigint; // for the LeaderboardWindowSnapshot heartbeat flush
}

function appendUnique(values: readonly string[], value: string): string[] {
  if (values.includes(value)) return [...values];
  return [...values, value].sort();
}

function subtractCount(value: number, amount: number): number {
  return Math.max(0, value - amount);
}

function subtractWei(value: bigint, amount: bigint): bigint {
  return value > amount ? value - amount : 0n;
}

/**
 * Update all leaderboard rollup entities for one swap. Idempotent at the (id)
 * level — re-running on the same event yields the same final state because:
 * - Counters are running totals: incrementing is `existing.x + 1`, but
 *   marker entities short-circuit the second increment.
 * - USD/fee fields accumulate; on re-sync the entire history replays in
 *   order so totals reproduce.
 */
export async function applyLeaderboardSnapshots(
  args: ApplyLeaderboardSnapshotsArgs,
): Promise<void> {
  const {
    context,
    chainId,
    poolId,
    pool,
    caller,
    txTo,
    volumeUsdWei,
    amounts,
    blockTimestamp,
    blockNumber,
  } = args;

  // Skip swaps where caller is missing — Envio's transaction.from fallback
  // to "" can produce these and a blank trader key would corrupt the
  // leaderboard's primary axis. Better to drop than to bucket as "".
  if (!caller) return;

  // Skip uncomputable USD swaps. `computeSwapUsdWei` returns 0n in two
  // cases: (1) a degenerate zero-amount swap (impossible from a real
  // SwapEvent) and (2) a pool whose USD value can't be derived from the
  // pegged-side trick (neither leg is in USD_PEGGED_SYMBOLS — e.g. a
  // hypothetical axlEUROC/EURm pool). Writing 0n into the rollups would
  // collapse "uncomputable" with "real zero volume" and silently
  // undercount those pools' traders. The raw SwapEvent still records the
  // unit token amounts and the original `volumeUsdWei = 0n` — a future
  // PR can backfill the rollups via a recovery job once a proper rate
  // map is wired up indexer-side.
  if (volumeUsdWei === 0n) return;

  const day = dayBucket(blockTimestamp);
  const dayKey = day.toString();
  const traderDayId = `${chainId}-${caller}-${dayKey}`;
  const traderPoolDayId = `${chainId}-${caller}-${poolId}-${dayKey}`;
  const poolDayId = `${chainId}-${poolId}-${dayKey}`;

  const aggregator = classifyAggregator(
    chainId,
    txTo,
    extractAddressFromPoolId(poolId),
  );
  const aggDayId = `${chainId}-${aggregator}-${dayKey}`;
  const aggTraderDayMarkerId = `${chainId}-${aggregator}-${caller}-${dayKey}`;

  // Total trader fee burden = LP fee + protocol fee. Pool entity carries both
  // as bps; `applyFeeBps` clamps the -1/-2 sentinels (RPC not yet read /
  // getter missing) to 0 so VirtualPools and freshly-deployed FPMMs don't
  // double-count fees.
  const feeBpsTotal = Math.max(0, pool.lpFee) + Math.max(0, pool.protocolFee);
  const feesPaidUsdWei = applyFeeBps(volumeUsdWei, feeBpsTotal);
  const callerIsSystem = isSystemAddress(chainId, caller, pool);

  // Direction-split USD-wei. In standard Uniswap-V2 swaps exactly one of
  // {In, Out} per side is non-zero; the other check is the "callback flow"
  // safety net documented in src/usd.ts. Both sides contribute volumeUsdWei
  // (one inflow + one outflow per swap); sum = 2 × volumeUsdWei.
  const inflowToken0 = amounts.amount0Out > 0n ? volumeUsdWei : 0n;
  const outflowToken0 = amounts.amount0In > 0n ? volumeUsdWei : 0n;
  const inflowToken1 = amounts.amount1Out > 0n ? volumeUsdWei : 0n;
  const outflowToken1 = amounts.amount1In > 0n ? volumeUsdWei : 0n;

  // Load independent rows concurrently so Envio's v3 preload phase can batch
  // all base leaderboard reads for this event into as few DB queries as
  // possible.
  const [
    existingTraderPoolMarker,
    existingAggTraderMarker,
    existingTraderDay,
    existingTraderPoolDay,
    existingPoolDay,
    existingAggDay,
  ] = await Promise.all([
    context.TraderPoolDayMarker.get(traderPoolDayId),
    context.AggregatorTraderDayMarker.get(aggTraderDayMarkerId),
    context.TraderDailySnapshot.get(traderDayId),
    context.TraderPoolDailySnapshot.get(traderPoolDayId),
    context.PoolDailyVolumeSnapshot.get(poolDayId),
    context.AggregatorDailySnapshot.get(aggDayId),
  ]);

  // 1. TraderPoolDayMarker → first-touch dedup for TraderDailySnapshot.uniquePools.
  //    Marker key matches the parent snapshot key — same string, different
  //    entity table.
  const traderPoolFirstTouch = existingTraderPoolMarker === undefined;
  if (traderPoolFirstTouch) {
    context.TraderPoolDayMarker.set({ id: traderPoolDayId });
  }

  // 2. AggregatorTraderDayMarker → first-touch dedup for
  //    AggregatorDailySnapshot.uniqueTraders plus per-trader counters used
  //    if the day-sticky system flag flips after earlier same-day swaps.
  const aggTraderFirstTouch = existingAggTraderMarker === undefined;

  // 3. TraderDailySnapshot upsert.
  const traderDayWasSystem = existingTraderDay?.isSystemAddress ?? false;
  const traderDayIsSystem = traderDayWasSystem || callerIsSystem;
  const traderDayBecameSystem =
    existingTraderDay !== undefined && !traderDayWasSystem && callerIsSystem;
  const aggregatorKeys = appendUnique(
    existingTraderDay?.aggregatorKeys ?? [],
    aggregator,
  );
  const poolIds = appendUnique(existingTraderDay?.poolIds ?? [], poolId);
  context.TraderDailySnapshot.set({
    id: traderDayId,
    chainId,
    trader: caller,
    timestamp: day,
    swapCount: (existingTraderDay?.swapCount ?? 0) + 1,
    uniquePools:
      (existingTraderDay?.uniquePools ?? 0) + (traderPoolFirstTouch ? 1 : 0),
    aggregatorKeys,
    poolIds,
    volumeUsdWei: (existingTraderDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
    feesPaidUsdWei: (existingTraderDay?.feesPaidUsdWei ?? 0n) + feesPaidUsdWei,
    // Sticky once true: a trader flagged as system at any point in a day
    // stays system for the full day's snapshot. Rebalancer EOAs that swap
    // once via a third-party router would otherwise toggle.
    isSystemAddress: traderDayIsSystem,
    lastSeenTimestamp: blockTimestamp,
  });

  // 4. TraderPoolDailySnapshot upsert.
  context.TraderPoolDailySnapshot.set({
    id: traderPoolDayId,
    chainId,
    trader: caller,
    poolId,
    timestamp: day,
    swapCount: (existingTraderPoolDay?.swapCount ?? 0) + 1,
    volumeUsdWei: (existingTraderPoolDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
    inflowToken0UsdWei:
      (existingTraderPoolDay?.inflowToken0UsdWei ?? 0n) + inflowToken0,
    outflowToken0UsdWei:
      (existingTraderPoolDay?.outflowToken0UsdWei ?? 0n) + outflowToken0,
    inflowToken1UsdWei:
      (existingTraderPoolDay?.inflowToken1UsdWei ?? 0n) + inflowToken1,
    outflowToken1UsdWei:
      (existingTraderPoolDay?.outflowToken1UsdWei ?? 0n) + outflowToken1,
    feesPaidUsdWei:
      (existingTraderPoolDay?.feesPaidUsdWei ?? 0n) + feesPaidUsdWei,
  });

  // 5. PoolDailyVolumeSnapshot upsert. This is the chart-facing pool/day
  //    rollup, so the dashboard no longer has to scan trader-pool rows and
  //    then intersect them with the trader-day system-address allowlist. If
  //    the trader flips into day-sticky system classification, remove their
  //    earlier same-day pool contributions from the primary branch.
  const primaryCorrectionsByPool = new Map<
    string,
    { swapCount: number; volumeUsdWei: bigint }
  >();
  if (traderDayBecameSystem) {
    const priorTraderPoolDays = await Promise.all(
      poolIds.map(async (touchedPoolId) => {
        const priorTraderPoolDay =
          touchedPoolId === poolId
            ? existingTraderPoolDay
            : await context.TraderPoolDailySnapshot.get(
                `${chainId}-${caller}-${touchedPoolId}-${dayKey}`,
              );
        return { touchedPoolId, priorTraderPoolDay };
      }),
    );
    for (const { touchedPoolId, priorTraderPoolDay } of priorTraderPoolDays) {
      if (!priorTraderPoolDay) continue;
      primaryCorrectionsByPool.set(touchedPoolId, {
        swapCount: priorTraderPoolDay.swapCount,
        volumeUsdWei: priorTraderPoolDay.volumeUsdWei,
      });
    }
    const touchedPoolDays = await Promise.all(
      Array.from(primaryCorrectionsByPool, async ([touchedPoolId]) => {
        if (touchedPoolId === poolId) return { touchedPoolId };
        const touchedPoolDayId = `${chainId}-${touchedPoolId}-${dayKey}`;
        const touchedPoolDay =
          await context.PoolDailyVolumeSnapshot.get(touchedPoolDayId);
        return { touchedPoolId, touchedPoolDay };
      }),
    );
    for (const { touchedPoolId, touchedPoolDay } of touchedPoolDays) {
      if (touchedPoolId === poolId) continue;
      if (!touchedPoolDay) continue;
      const correction = primaryCorrectionsByPool.get(touchedPoolId);
      if (!correction) continue;
      context.PoolDailyVolumeSnapshot.set({
        ...touchedPoolDay,
        swapCount: subtractCount(
          touchedPoolDay.swapCount,
          correction.swapCount,
        ),
        volumeUsdWei: subtractWei(
          touchedPoolDay.volumeUsdWei,
          correction.volumeUsdWei,
        ),
        blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
    }
  }
  const currentPoolCorrection = primaryCorrectionsByPool.get(poolId);
  const poolPrimarySwapBase = subtractCount(
    existingPoolDay?.swapCount ?? 0,
    currentPoolCorrection?.swapCount ?? 0,
  );
  const poolPrimaryVolumeBase = subtractWei(
    existingPoolDay?.volumeUsdWei ?? 0n,
    currentPoolCorrection?.volumeUsdWei ?? 0n,
  );
  context.PoolDailyVolumeSnapshot.set({
    id: poolDayId,
    chainId,
    poolId,
    timestamp: day,
    swapCount: poolPrimarySwapBase + (traderDayIsSystem ? 0 : 1),
    swapCountIncludingSystem:
      (existingPoolDay?.swapCountIncludingSystem ?? 0) + 1,
    volumeUsdWei:
      poolPrimaryVolumeBase + (traderDayIsSystem ? 0n : volumeUsdWei),
    volumeUsdWeiIncludingSystem:
      (existingPoolDay?.volumeUsdWeiIncludingSystem ?? 0n) + volumeUsdWei,
    blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });

  // 6. AggregatorDailySnapshot upsert. Primary fields exclude system callers;
  //    *IncludingSystem siblings preserve the toggle path. If this swap made
  //    the trader-day sticky-system, subtract all earlier same-day aggregator
  //    contributions from primary fields before applying the current event.
  const primaryCorrectionsByAggregator = new Map<
    string,
    {
      swapCount: number;
      uniqueTraders: number;
      volumeUsdWei: bigint;
      feesPaidUsdWei: bigint;
    }
  >();
  if (traderDayBecameSystem) {
    const touchedAggMarkers = await Promise.all(
      aggregatorKeys.map(async (touchedAggregator) => {
        const marker =
          touchedAggregator === aggregator
            ? existingAggTraderMarker
            : await context.AggregatorTraderDayMarker.get(
                `${chainId}-${touchedAggregator}-${caller}-${dayKey}`,
              );
        return { touchedAggregator, marker };
      }),
    );
    for (const { touchedAggregator, marker } of touchedAggMarkers) {
      if (!marker || marker.isSystemAddress) continue;
      primaryCorrectionsByAggregator.set(touchedAggregator, {
        swapCount: marker.swapCount,
        uniqueTraders: 1,
        volumeUsdWei: marker.volumeUsdWei,
        feesPaidUsdWei: marker.feesPaidUsdWei,
      });
    }

    const touchedAggDays = await Promise.all(
      Array.from(
        primaryCorrectionsByAggregator,
        async ([touchedAggregator]) => {
          if (touchedAggregator === aggregator) return { touchedAggregator };
          const touchedAggDayId = `${chainId}-${touchedAggregator}-${dayKey}`;
          const touchedAggDay =
            await context.AggregatorDailySnapshot.get(touchedAggDayId);
          return { touchedAggregator, touchedAggDay };
        },
      ),
    );
    for (const { touchedAggregator, touchedAggDay } of touchedAggDays) {
      if (touchedAggregator === aggregator) continue;
      if (!touchedAggDay) continue;
      const correction = primaryCorrectionsByAggregator.get(touchedAggregator);
      if (!correction) continue;
      context.AggregatorDailySnapshot.set({
        ...touchedAggDay,
        swapCount: subtractCount(touchedAggDay.swapCount, correction.swapCount),
        uniqueTraders: subtractCount(
          touchedAggDay.uniqueTraders,
          correction.uniqueTraders,
        ),
        volumeUsdWei: subtractWei(
          touchedAggDay.volumeUsdWei,
          correction.volumeUsdWei,
        ),
        feesPaidUsdWei: subtractWei(
          touchedAggDay.feesPaidUsdWei,
          correction.feesPaidUsdWei,
        ),
      });
    }
  }

  //    `lastSeenAggregatorAddress` is the raw txTo so the dashboard can
  //    surface the actual router contract
  //    (useful when an aggregator has multiple deployed addresses on a chain
  //    and we want to know which one drove this row).
  const currentAggCorrection = primaryCorrectionsByAggregator.get(aggregator);
  const primarySwapBase = subtractCount(
    existingAggDay?.swapCount ?? 0,
    currentAggCorrection?.swapCount ?? 0,
  );
  const primaryUniqueBase = subtractCount(
    existingAggDay?.uniqueTraders ?? 0,
    currentAggCorrection?.uniqueTraders ?? 0,
  );
  const primaryVolumeBase = subtractWei(
    existingAggDay?.volumeUsdWei ?? 0n,
    currentAggCorrection?.volumeUsdWei ?? 0n,
  );
  const primaryFeesBase = subtractWei(
    existingAggDay?.feesPaidUsdWei ?? 0n,
    currentAggCorrection?.feesPaidUsdWei ?? 0n,
  );
  context.AggregatorDailySnapshot.set({
    id: aggDayId,
    chainId,
    aggregator,
    lastSeenAggregatorAddress: txTo,
    timestamp: day,
    swapCount: primarySwapBase + (traderDayIsSystem ? 0 : 1),
    swapCountIncludingSystem:
      (existingAggDay?.swapCountIncludingSystem ?? 0) + 1,
    uniqueTraders:
      primaryUniqueBase + (!traderDayIsSystem && aggTraderFirstTouch ? 1 : 0),
    uniqueTradersIncludingSystem:
      (existingAggDay?.uniqueTradersIncludingSystem ?? 0) +
      (aggTraderFirstTouch ? 1 : 0),
    volumeUsdWei: primaryVolumeBase + (traderDayIsSystem ? 0n : volumeUsdWei),
    volumeUsdWeiIncludingSystem:
      (existingAggDay?.volumeUsdWeiIncludingSystem ?? 0n) + volumeUsdWei,
    feesPaidUsdWei: primaryFeesBase + (traderDayIsSystem ? 0n : feesPaidUsdWei),
    feesPaidUsdWeiIncludingSystem:
      (existingAggDay?.feesPaidUsdWeiIncludingSystem ?? 0n) + feesPaidUsdWei,
  });

  context.AggregatorTraderDayMarker.set({
    id: aggTraderDayMarkerId,
    chainId,
    aggregator,
    trader: caller,
    timestamp: day,
    swapCount: (existingAggTraderMarker?.swapCount ?? 0) + 1,
    volumeUsdWei: (existingAggTraderMarker?.volumeUsdWei ?? 0n) + volumeUsdWei,
    feesPaidUsdWei:
      (existingAggTraderMarker?.feesPaidUsdWei ?? 0n) + feesPaidUsdWei,
    isSystemAddress:
      (existingAggTraderMarker?.isSystemAddress ?? false) || traderDayIsSystem,
  });

  // 7. Heartbeat: flush LeaderboardWindowSnapshot rows for any closed UTC
  //    days since the last flush. Reads only TraderDailySnapshot
  //    (already-written including this swap's row), filters by
  //    [windowStartDay, snapshotDay] inclusive — today's row is excluded
  //    by the upper bound, so we never write a "today" snapshot. The
  //    dashboard adds today's partial from a small direct query.
  await maybeHeartbeatFlushV3({
    context,
    chainId,
    blockTimestamp,
    blockNumber,
  });
}
