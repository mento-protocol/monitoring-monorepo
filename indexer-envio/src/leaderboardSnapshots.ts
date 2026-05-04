import type {
  AggregatorDailySnapshot,
  AggregatorTraderDayMarker,
  Pool,
  TraderDailySnapshot,
  TraderPoolDailySnapshot,
  TraderPoolDayMarker,
} from "generated";
import { applyFeeBps } from "./usd";
import { isSystemAddress } from "./system-addresses";
import { classifyAggregator } from "./aggregators";
import { dayBucket, extractAddressFromPoolId } from "./helpers";

/** Subset of Envio's handler context that the leaderboard snapshot helper
 *  reads/writes. Both the FPMM and VirtualPool swap handlers' contexts are
 *  structurally compatible with this shape. */
export type LeaderboardContext = {
  TraderDailySnapshot: {
    get: (id: string) => Promise<TraderDailySnapshot | undefined>;
    set: (entity: TraderDailySnapshot) => void;
  };
  TraderPoolDailySnapshot: {
    get: (id: string) => Promise<TraderPoolDailySnapshot | undefined>;
    set: (entity: TraderPoolDailySnapshot) => void;
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

  // Direction-split USD-wei. In standard Uniswap-V2 swaps exactly one of
  // {In, Out} per side is non-zero; the other check is the "callback flow"
  // safety net documented in src/usd.ts. Both sides contribute volumeUsdWei
  // (one inflow + one outflow per swap); sum = 2 × volumeUsdWei.
  const inflowToken0 = amounts.amount0Out > 0n ? volumeUsdWei : 0n;
  const outflowToken0 = amounts.amount0In > 0n ? volumeUsdWei : 0n;
  const inflowToken1 = amounts.amount1Out > 0n ? volumeUsdWei : 0n;
  const outflowToken1 = amounts.amount1In > 0n ? volumeUsdWei : 0n;

  // 1. TraderPoolDayMarker → first-touch dedup for TraderDailySnapshot.uniquePools.
  //    Marker key matches the parent snapshot key — same string, different
  //    entity table.
  const existingTraderPoolMarker =
    await context.TraderPoolDayMarker.get(traderPoolDayId);
  const traderPoolFirstTouch = existingTraderPoolMarker === undefined;
  if (traderPoolFirstTouch) {
    context.TraderPoolDayMarker.set({ id: traderPoolDayId });
  }

  // 2. AggregatorTraderDayMarker → first-touch dedup for
  //    AggregatorDailySnapshot.uniqueTraders.
  const existingAggTraderMarker =
    await context.AggregatorTraderDayMarker.get(aggTraderDayMarkerId);
  const aggTraderFirstTouch = existingAggTraderMarker === undefined;
  if (aggTraderFirstTouch) {
    context.AggregatorTraderDayMarker.set({ id: aggTraderDayMarkerId });
  }

  // 3. TraderDailySnapshot upsert.
  const existingTraderDay = await context.TraderDailySnapshot.get(traderDayId);
  context.TraderDailySnapshot.set({
    id: traderDayId,
    chainId,
    trader: caller,
    timestamp: day,
    swapCount: (existingTraderDay?.swapCount ?? 0) + 1,
    uniquePools:
      (existingTraderDay?.uniquePools ?? 0) + (traderPoolFirstTouch ? 1 : 0),
    volumeUsdWei: (existingTraderDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
    feesPaidUsdWei: (existingTraderDay?.feesPaidUsdWei ?? 0n) + feesPaidUsdWei,
    isSystemAddress: existingTraderDay
      ? // Sticky once true: a trader flagged as system at any point in a day
        // stays system for the full day's snapshot. Rebalancer EOAs that swap
        // once via a third-party router would otherwise toggle.
        existingTraderDay.isSystemAddress ||
        isSystemAddress(chainId, caller, pool)
      : isSystemAddress(chainId, caller, pool),
    lastSeenTimestamp: blockTimestamp,
  });

  // 4. TraderPoolDailySnapshot upsert.
  const existingTraderPoolDay =
    await context.TraderPoolDailySnapshot.get(traderPoolDayId);
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

  // 5. AggregatorDailySnapshot upsert. `lastSeenAggregatorAddress` is the
  //    raw txTo so the dashboard can surface the actual router contract
  //    (useful when an aggregator has multiple deployed addresses on a chain
  //    and we want to know which one drove this row).
  const existingAggDay = await context.AggregatorDailySnapshot.get(aggDayId);
  context.AggregatorDailySnapshot.set({
    id: aggDayId,
    chainId,
    aggregator,
    lastSeenAggregatorAddress: txTo,
    timestamp: day,
    swapCount: (existingAggDay?.swapCount ?? 0) + 1,
    uniqueTraders:
      (existingAggDay?.uniqueTraders ?? 0) + (aggTraderFirstTouch ? 1 : 0),
    volumeUsdWei: (existingAggDay?.volumeUsdWei ?? 0n) + volumeUsdWei,
    feesPaidUsdWei: (existingAggDay?.feesPaidUsdWei ?? 0n) + feesPaidUsdWei,
  });
}
