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
import {
  isProtocolActorEntryPoint,
  isProtocolOwnedAddress,
} from "./protocol-actors.js";
import { classifyAggregator } from "./aggregators.js";
import { dayBucket, extractAddressFromPoolId } from "./helpers.js";
import {
  maybeHeartbeatFlushV3,
  type V3FlushContext,
} from "./volumeWindowFlush.js";

/** Subset of Envio's handler context that the volume snapshot helper
 *  reads/writes. Both the FPMM and VirtualPool swap handlers' contexts are
 *  structurally compatible with this shape. */
export type VolumeContext = V3FlushContext & {
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

export interface ApplyVolumeSnapshotsArgs {
  context: VolumeContext;
  chainId: number;
  poolId: string;
  pool: Pool;
  caller: string; // tx.from, lowercased — the trader key
  txTo: string; // tx.to, lowercased — the entry-point contract for aggregator classification
  volumeUsdWei: bigint; // pre-computed via computeSwapUsdWei (lives on SwapEvent)
  amounts: SwapAmounts;
  blockTimestamp: bigint;
  blockNumber: bigint; // for the VolumeWindowSnapshot heartbeat flush
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

interface SnapContext {
  chainId: number;
  caller: string;
  poolId: string;
  pool: Pool;
  txTo: string;
  blockTimestamp: bigint;
  blockNumber: bigint;
  day: bigint;
  dayKey: string;
  traderDayId: string;
  traderPoolDayId: string;
  poolDayId: string;
  aggregator: string;
  aggDayId: string;
  aggTraderDayMarkerId: string;
  volumeUsdWei: bigint;
  feesPaidUsdWei: bigint;
  callerIsProtocolActor: boolean;
  inflowToken0: bigint;
  outflowToken0: bigint;
  inflowToken1: bigint;
  outflowToken1: bigint;
}

interface ExistingEntries {
  traderPoolMarker: TraderPoolDayMarker | undefined;
  aggTraderMarker: AggregatorTraderDayMarker | undefined;
  traderDay: TraderDailySnapshot | undefined;
  traderPoolDay: TraderPoolDailySnapshot | undefined;
  poolDay: PoolDailyVolumeSnapshot | undefined;
  aggDay: AggregatorDailySnapshot | undefined;
}

interface TraderDaySnapshotState {
  traderDayBecameProtocolActor: boolean;
  traderDayIsProtocolActor: boolean;
  aggregatorKeys: string[];
  poolIds: string[];
}

/**
 * Update all volume rollup entities for one swap. Idempotent at the (id)
 * level — re-running on the same event yields the same final state because:
 * - Counters are running totals: incrementing is `existing.x + 1`, but
 *   marker entities short-circuit the second increment.
 * - USD/fee fields accumulate; on re-sync the entire history replays in
 *   order so totals reproduce.
 */
export async function applyVolumeSnapshots(
  args: ApplyVolumeSnapshotsArgs,
): Promise<void> {
  const { context, chainId, blockTimestamp, blockNumber } = args;
  const flushVolumeWindow = () =>
    maybeHeartbeatFlushV3({ context, chainId, blockTimestamp, blockNumber });

  // Skip swaps where caller is missing — Envio's transaction.from fallback
  // to "" can produce these and a blank trader key would corrupt the
  // volume table's primary axis. Better to drop than to bucket as "", but
  // still run the chain heartbeat because the event proves time advanced.
  if (!args.caller) {
    await flushVolumeWindow();
    return;
  }

  // Skip uncomputable USD swaps. `computeSwapUsdWei` returns 0n in two
  // cases: (1) a degenerate zero-amount swap (impossible from a real
  // SwapEvent) and (2) a pool whose USD value can't be derived from the
  // pegged-side trick (neither leg is in USD_PEGGED_SYMBOLS — e.g. a
  // hypothetical axlEUROC/EURm pool). Writing 0n into the rollups would
  // collapse "uncomputable" with "real zero volume" and silently
  // undercount those pools' traders.
  if (args.volumeUsdWei === 0n) {
    await flushVolumeWindow();
    return;
  }

  const snap = buildSnapContext(args);
  const existing = await loadExistingEntries(context, snap);

  const traderPoolFirstTouch = existing.traderPoolMarker === undefined;
  if (traderPoolFirstTouch) {
    context.TraderPoolDayMarker.set({ id: snap.traderPoolDayId });
  }
  const aggTraderFirstTouch = existing.aggTraderMarker === undefined;

  const traderDayState = upsertTraderDailySnapshot(
    context,
    snap,
    existing.traderDay,
    traderPoolFirstTouch,
  );

  upsertTraderPoolDailySnapshot(context, snap, existing.traderPoolDay);

  await upsertPoolDailyVolumeSnapshot(context, snap, {
    existing: existing.poolDay,
    existingTraderPoolDay: existing.traderPoolDay,
    traderDayState,
  });

  await upsertAggregatorDailySnapshot(context, snap, {
    existing: existing.aggDay,
    existingAggTraderMarker: existing.aggTraderMarker,
    traderDayState,
    aggTraderFirstTouch,
  });

  upsertAggregatorTraderDayMarker(
    context,
    snap,
    existing.aggTraderMarker,
    traderDayState.traderDayIsProtocolActor,
  );

  // Heartbeat: flush VolumeWindowSnapshot rows for any closed UTC days
  // since the last flush. Reads only TraderDailySnapshot (already-written
  // including this swap's row), filters by [windowStartDay, snapshotDay]
  // inclusive — today's row is excluded by the upper bound, so we never write
  // a "today" snapshot. The dashboard adds today's partial from a small direct
  // query.
  await flushVolumeWindow();
}

function buildSnapContext(args: ApplyVolumeSnapshotsArgs): SnapContext {
  const {
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

  const day = dayBucket(blockTimestamp);
  const dayKey = day.toString();
  const aggregator = classifyAggregator(
    chainId,
    txTo,
    extractAddressFromPoolId(poolId),
    pool,
  );

  // Total trader fee burden = LP fee + protocol fee. Pool entity carries both
  // as bps; `applyFeeBps` clamps the -1/-2 sentinels (RPC not yet read /
  // getter missing) to 0 so VirtualPools and freshly-deployed FPMMs don't
  // double-count fees.
  const feeBpsTotal = Math.max(0, pool.lpFee) + Math.max(0, pool.protocolFee);

  return {
    chainId,
    caller,
    poolId,
    pool,
    txTo,
    blockTimestamp,
    blockNumber,
    day,
    dayKey,
    traderDayId: `${chainId}-${caller}-${dayKey}`,
    traderPoolDayId: `${chainId}-${caller}-${poolId}-${dayKey}`,
    poolDayId: `${chainId}-${poolId}-${dayKey}`,
    aggregator,
    aggDayId: `${chainId}-${aggregator}-${dayKey}`,
    aggTraderDayMarkerId: `${chainId}-${aggregator}-${caller}-${dayKey}`,
    volumeUsdWei,
    feesPaidUsdWei: applyFeeBps(volumeUsdWei, feeBpsTotal),
    callerIsProtocolActor:
      isProtocolOwnedAddress(chainId, caller, pool) ||
      isProtocolActorEntryPoint(chainId, txTo, pool),
    // Direction-split USD-wei. In standard Uniswap-V2 swaps exactly one of
    // {In, Out} per side is non-zero; the other check is the "callback flow"
    // safety net documented in src/usd.ts. Both sides contribute volumeUsdWei
    // (one inflow + one outflow per swap); sum = 2 × volumeUsdWei.
    inflowToken0: amounts.amount0Out > 0n ? volumeUsdWei : 0n,
    outflowToken0: amounts.amount0In > 0n ? volumeUsdWei : 0n,
    inflowToken1: amounts.amount1Out > 0n ? volumeUsdWei : 0n,
    outflowToken1: amounts.amount1In > 0n ? volumeUsdWei : 0n,
  };
}

async function loadExistingEntries(
  context: VolumeContext,
  snap: SnapContext,
): Promise<ExistingEntries> {
  // Load independent rows concurrently so Envio's v3 preload phase can batch
  // all base volume reads for this event into as few DB queries as
  // possible.
  const [
    traderPoolMarker,
    aggTraderMarker,
    traderDay,
    traderPoolDay,
    poolDay,
    aggDay,
  ] = await Promise.all([
    context.TraderPoolDayMarker.get(snap.traderPoolDayId),
    context.AggregatorTraderDayMarker.get(snap.aggTraderDayMarkerId),
    context.TraderDailySnapshot.get(snap.traderDayId),
    context.TraderPoolDailySnapshot.get(snap.traderPoolDayId),
    context.PoolDailyVolumeSnapshot.get(snap.poolDayId),
    context.AggregatorDailySnapshot.get(snap.aggDayId),
  ]);
  return {
    traderPoolMarker,
    aggTraderMarker,
    traderDay,
    traderPoolDay,
    poolDay,
    aggDay,
  };
}

const EMPTY_TRADER_DAY = {
  swapCount: 0,
  uniquePools: 0,
  aggregatorKeys: [] as readonly string[],
  poolIds: [] as readonly string[],
  volumeUsdWei: 0n,
  feesPaidUsdWei: 0n,
  isProtocolActor: false,
};

function upsertTraderDailySnapshot(
  context: VolumeContext,
  snap: SnapContext,
  existing: TraderDailySnapshot | undefined,
  traderPoolFirstTouch: boolean,
): TraderDaySnapshotState {
  const prev = existing ?? EMPTY_TRADER_DAY;
  const traderDayIsProtocolActor =
    prev.isProtocolActor || snap.callerIsProtocolActor;
  const traderDayBecameProtocolActor =
    existing !== undefined &&
    !prev.isProtocolActor &&
    snap.callerIsProtocolActor;
  const aggregatorKeys = appendUnique(prev.aggregatorKeys, snap.aggregator);
  const poolIds = appendUnique(prev.poolIds, snap.poolId);

  context.TraderDailySnapshot.set({
    id: snap.traderDayId,
    chainId: snap.chainId,
    trader: snap.caller,
    timestamp: snap.day,
    swapCount: prev.swapCount + 1,
    uniquePools: prev.uniquePools + (traderPoolFirstTouch ? 1 : 0),
    aggregatorKeys,
    poolIds,
    volumeUsdWei: prev.volumeUsdWei + snap.volumeUsdWei,
    feesPaidUsdWei: prev.feesPaidUsdWei + snap.feesPaidUsdWei,
    // Sticky once true: a trader flagged as protocol actor at any point in a day
    // stays a protocol actor for the full day's snapshot. Rebalancer EOAs that swap
    // once via a third-party router would otherwise toggle.
    isProtocolActor: traderDayIsProtocolActor,
    lastSeenTimestamp: snap.blockTimestamp,
  });

  return {
    traderDayBecameProtocolActor,
    traderDayIsProtocolActor,
    aggregatorKeys,
    poolIds,
  };
}

const EMPTY_TRADER_POOL_DAY = {
  swapCount: 0,
  volumeUsdWei: 0n,
  inflowToken0UsdWei: 0n,
  outflowToken0UsdWei: 0n,
  inflowToken1UsdWei: 0n,
  outflowToken1UsdWei: 0n,
  feesPaidUsdWei: 0n,
};

function upsertTraderPoolDailySnapshot(
  context: VolumeContext,
  snap: SnapContext,
  existing: TraderPoolDailySnapshot | undefined,
) {
  const prev = existing ?? EMPTY_TRADER_POOL_DAY;
  context.TraderPoolDailySnapshot.set({
    id: snap.traderPoolDayId,
    chainId: snap.chainId,
    trader: snap.caller,
    poolId: snap.poolId,
    timestamp: snap.day,
    swapCount: prev.swapCount + 1,
    volumeUsdWei: prev.volumeUsdWei + snap.volumeUsdWei,
    inflowToken0UsdWei: prev.inflowToken0UsdWei + snap.inflowToken0,
    outflowToken0UsdWei: prev.outflowToken0UsdWei + snap.outflowToken0,
    inflowToken1UsdWei: prev.inflowToken1UsdWei + snap.inflowToken1,
    outflowToken1UsdWei: prev.outflowToken1UsdWei + snap.outflowToken1,
    feesPaidUsdWei: prev.feesPaidUsdWei + snap.feesPaidUsdWei,
  });
}

interface PoolDailyContext {
  existing: PoolDailyVolumeSnapshot | undefined;
  existingTraderPoolDay: TraderPoolDailySnapshot | undefined;
  traderDayState: TraderDaySnapshotState;
}

const EMPTY_POOL_DAY = {
  swapCount: 0,
  swapCountIncludingProtocolActors: 0,
  volumeUsdWei: 0n,
  volumeUsdWeiIncludingProtocolActors: 0n,
};

async function upsertPoolDailyVolumeSnapshot(
  context: VolumeContext,
  snap: SnapContext,
  ctx: PoolDailyContext,
) {
  // The chart-facing pool/day rollup, so the dashboard no longer has to scan
  // trader-pool rows and intersect with the trader-day protocol-owned address
  // allowlist. If the trader flips into day-sticky protocol-actor classification,
  // remove their earlier same-day pool contributions from the primary branch.
  const corrections = ctx.traderDayState.traderDayBecameProtocolActor
    ? await collectPoolPrimaryCorrections(context, snap, ctx)
    : new Map<string, { swapCount: number; volumeUsdWei: bigint }>();

  const prev = ctx.existing ?? EMPTY_POOL_DAY;
  const currentCorrection = corrections.get(snap.poolId) ?? {
    swapCount: 0,
    volumeUsdWei: 0n,
  };
  const isProtocolActor = ctx.traderDayState.traderDayIsProtocolActor;
  const primarySwapBase = subtractCount(
    prev.swapCount,
    currentCorrection.swapCount,
  );
  const primaryVolumeBase = subtractWei(
    prev.volumeUsdWei,
    currentCorrection.volumeUsdWei,
  );

  context.PoolDailyVolumeSnapshot.set({
    id: snap.poolDayId,
    chainId: snap.chainId,
    poolId: snap.poolId,
    timestamp: snap.day,
    swapCount: primarySwapBase + (isProtocolActor ? 0 : 1),
    swapCountIncludingProtocolActors: prev.swapCountIncludingProtocolActors + 1,
    volumeUsdWei:
      primaryVolumeBase + (isProtocolActor ? 0n : snap.volumeUsdWei),
    volumeUsdWeiIncludingProtocolActors:
      prev.volumeUsdWeiIncludingProtocolActors + snap.volumeUsdWei,
    blockNumber: snap.blockNumber,
    updatedAtTimestamp: snap.blockTimestamp,
  });
}

async function collectPoolPrimaryCorrections(
  context: VolumeContext,
  snap: SnapContext,
  ctx: PoolDailyContext,
): Promise<Map<string, { swapCount: number; volumeUsdWei: bigint }>> {
  const corrections = new Map<
    string,
    { swapCount: number; volumeUsdWei: bigint }
  >();
  const priorTraderPoolDays = await Promise.all(
    ctx.traderDayState.poolIds.map(async (touchedPoolId) => {
      const priorTraderPoolDay =
        touchedPoolId === snap.poolId
          ? ctx.existingTraderPoolDay
          : await context.TraderPoolDailySnapshot.get(
              `${snap.chainId}-${snap.caller}-${touchedPoolId}-${snap.dayKey}`,
            );
      return { touchedPoolId, priorTraderPoolDay };
    }),
  );
  for (const { touchedPoolId, priorTraderPoolDay } of priorTraderPoolDays) {
    if (!priorTraderPoolDay) continue;
    corrections.set(touchedPoolId, {
      swapCount: priorTraderPoolDay.swapCount,
      volumeUsdWei: priorTraderPoolDay.volumeUsdWei,
    });
  }

  const touchedPoolDays = await Promise.all(
    Array.from(corrections, async ([touchedPoolId]) => {
      if (touchedPoolId === snap.poolId) return { touchedPoolId };
      const touchedPoolDayId = `${snap.chainId}-${touchedPoolId}-${snap.dayKey}`;
      const touchedPoolDay =
        await context.PoolDailyVolumeSnapshot.get(touchedPoolDayId);
      return { touchedPoolId, touchedPoolDay };
    }),
  );
  for (const { touchedPoolId, touchedPoolDay } of touchedPoolDays) {
    if (touchedPoolId === snap.poolId) continue;
    if (!touchedPoolDay) continue;
    const correction = corrections.get(touchedPoolId);
    if (!correction) continue;
    context.PoolDailyVolumeSnapshot.set({
      ...touchedPoolDay,
      swapCount: subtractCount(touchedPoolDay.swapCount, correction.swapCount),
      volumeUsdWei: subtractWei(
        touchedPoolDay.volumeUsdWei,
        correction.volumeUsdWei,
      ),
      blockNumber: snap.blockNumber,
      updatedAtTimestamp: snap.blockTimestamp,
    });
  }

  return corrections;
}

interface AggregatorDailyContext {
  existing: AggregatorDailySnapshot | undefined;
  existingAggTraderMarker: AggregatorTraderDayMarker | undefined;
  traderDayState: TraderDaySnapshotState;
  aggTraderFirstTouch: boolean;
}

interface AggregatorCorrection {
  swapCount: number;
  uniqueTraders: number;
  volumeUsdWei: bigint;
  feesPaidUsdWei: bigint;
}

const EMPTY_AGG_DAY = {
  swapCount: 0,
  swapCountIncludingProtocolActors: 0,
  uniqueTraders: 0,
  uniqueTradersIncludingProtocolActors: 0,
  volumeUsdWei: 0n,
  volumeUsdWeiIncludingProtocolActors: 0n,
  feesPaidUsdWei: 0n,
  feesPaidUsdWeiIncludingProtocolActors: 0n,
};

const EMPTY_AGG_CORRECTION: AggregatorCorrection = {
  swapCount: 0,
  uniqueTraders: 0,
  volumeUsdWei: 0n,
  feesPaidUsdWei: 0n,
};

async function upsertAggregatorDailySnapshot(
  context: VolumeContext,
  snap: SnapContext,
  ctx: AggregatorDailyContext,
) {
  // Primary fields exclude protocol actors callers; *IncludingProtocolActors siblings preserve
  // the toggle path. If this swap made the trader-day sticky-protocol, subtract
  // all earlier same-day aggregator contributions from primary fields before
  // applying the current event.
  const corrections = ctx.traderDayState.traderDayBecameProtocolActor
    ? await collectAggregatorPrimaryCorrections(context, snap, ctx)
    : new Map<string, AggregatorCorrection>();

  const prev = ctx.existing ?? EMPTY_AGG_DAY;
  const correction = corrections.get(snap.aggregator) ?? EMPTY_AGG_CORRECTION;
  const isProtocolActor = ctx.traderDayState.traderDayIsProtocolActor;
  const firstTouch = ctx.aggTraderFirstTouch;

  const primarySwapBase = subtractCount(prev.swapCount, correction.swapCount);
  const primaryUniqueBase = subtractCount(
    prev.uniqueTraders,
    correction.uniqueTraders,
  );
  const primaryVolumeBase = subtractWei(
    prev.volumeUsdWei,
    correction.volumeUsdWei,
  );
  const primaryFeesBase = subtractWei(
    prev.feesPaidUsdWei,
    correction.feesPaidUsdWei,
  );

  // `lastSeenAggregatorAddress` is the raw txTo so the dashboard can surface
  // the actual router contract (useful when an aggregator has multiple
  // deployed addresses on a chain and we want to know which one drove this
  // row).
  context.AggregatorDailySnapshot.set({
    id: snap.aggDayId,
    chainId: snap.chainId,
    aggregator: snap.aggregator,
    lastSeenAggregatorAddress: snap.txTo,
    timestamp: snap.day,
    swapCount: primarySwapBase + (isProtocolActor ? 0 : 1),
    swapCountIncludingProtocolActors: prev.swapCountIncludingProtocolActors + 1,
    uniqueTraders: primaryUniqueBase + (!isProtocolActor && firstTouch ? 1 : 0),
    uniqueTradersIncludingProtocolActors:
      prev.uniqueTradersIncludingProtocolActors + (firstTouch ? 1 : 0),
    volumeUsdWei:
      primaryVolumeBase + (isProtocolActor ? 0n : snap.volumeUsdWei),
    volumeUsdWeiIncludingProtocolActors:
      prev.volumeUsdWeiIncludingProtocolActors + snap.volumeUsdWei,
    feesPaidUsdWei:
      primaryFeesBase + (isProtocolActor ? 0n : snap.feesPaidUsdWei),
    feesPaidUsdWeiIncludingProtocolActors:
      prev.feesPaidUsdWeiIncludingProtocolActors + snap.feesPaidUsdWei,
  });
}

async function collectAggregatorPrimaryCorrections(
  context: VolumeContext,
  snap: SnapContext,
  ctx: AggregatorDailyContext,
): Promise<Map<string, AggregatorCorrection>> {
  const corrections = new Map<string, AggregatorCorrection>();
  const touchedAggMarkers = await Promise.all(
    ctx.traderDayState.aggregatorKeys.map(async (touchedAggregator) => {
      const marker =
        touchedAggregator === snap.aggregator
          ? ctx.existingAggTraderMarker
          : await context.AggregatorTraderDayMarker.get(
              `${snap.chainId}-${touchedAggregator}-${snap.caller}-${snap.dayKey}`,
            );
      return { touchedAggregator, marker };
    }),
  );
  for (const { touchedAggregator, marker } of touchedAggMarkers) {
    if (!marker || marker.isProtocolActor) continue;
    corrections.set(touchedAggregator, {
      swapCount: marker.swapCount,
      uniqueTraders: 1,
      volumeUsdWei: marker.volumeUsdWei,
      feesPaidUsdWei: marker.feesPaidUsdWei,
    });
  }

  const touchedAggDays = await Promise.all(
    Array.from(corrections, async ([touchedAggregator]) => {
      if (touchedAggregator === snap.aggregator) return { touchedAggregator };
      const touchedAggDayId = `${snap.chainId}-${touchedAggregator}-${snap.dayKey}`;
      const touchedAggDay =
        await context.AggregatorDailySnapshot.get(touchedAggDayId);
      return { touchedAggregator, touchedAggDay };
    }),
  );
  for (const { touchedAggregator, touchedAggDay } of touchedAggDays) {
    if (touchedAggregator === snap.aggregator) continue;
    if (!touchedAggDay) continue;
    const correction = corrections.get(touchedAggregator);
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

  return corrections;
}

const EMPTY_AGG_TRADER_MARKER = {
  swapCount: 0,
  volumeUsdWei: 0n,
  feesPaidUsdWei: 0n,
  isProtocolActor: false,
};

function upsertAggregatorTraderDayMarker(
  context: VolumeContext,
  snap: SnapContext,
  existing: AggregatorTraderDayMarker | undefined,
  traderDayIsProtocolActor: boolean,
) {
  const prev = existing ?? EMPTY_AGG_TRADER_MARKER;
  context.AggregatorTraderDayMarker.set({
    id: snap.aggTraderDayMarkerId,
    chainId: snap.chainId,
    aggregator: snap.aggregator,
    trader: snap.caller,
    timestamp: snap.day,
    swapCount: prev.swapCount + 1,
    volumeUsdWei: prev.volumeUsdWei + snap.volumeUsdWei,
    feesPaidUsdWei: prev.feesPaidUsdWei + snap.feesPaidUsdWei,
    isProtocolActor: prev.isProtocolActor || traderDayIsProtocolActor,
  });
}
