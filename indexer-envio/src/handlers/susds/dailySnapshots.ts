import type { SusdsYieldDailySnapshot } from "envio";
import { SECONDS_PER_DAY, dayBucket } from "../../helpers.js";
import {
  blockTimestampEffect,
  susdsSharePriceEffect,
} from "../../rpc/effects.js";
import { computeYieldTotals } from "./positions.js";
import {
  ETHEREUM_CHAIN_ID,
  SUSDS_ADDRESS,
  V3_REVENUE_LAUNCH_BLOCK,
  V3_REVENUE_LAUNCH_TIMESTAMP,
  ZERO,
  type BlockMeta,
  type SusdsContext,
  type SusdsYieldTotals,
} from "./shared.js";

function susdsDailySnapshotId(chainId: number, bucket: bigint): string {
  return `${chainId}-susds-${bucket}`;
}

type SusdsYieldDeltaBaseline = Pick<
  SusdsYieldDailySnapshot | SusdsYieldTotals,
  "totalEarnedYieldUsdWei" | "realizedYieldUsdWei" | "unrealizedYieldUsdWei"
>;

type SusdsYieldDailySnapshotOptions = {
  requirePreviousDay?: boolean;
  allowZeroTotals?: boolean;
};

type SusdsHeartbeatEffectResults = {
  blockTimestamp: bigint | null;
  sharePriceUsdWei: bigint | null;
};

function baselineFromSameDaySnapshot(
  snapshot: SusdsYieldDailySnapshot,
): SusdsYieldDeltaBaseline {
  return {
    totalEarnedYieldUsdWei:
      snapshot.totalEarnedYieldUsdWei - snapshot.dailyEarnedYieldUsdWei,
    realizedYieldUsdWei:
      snapshot.realizedYieldUsdWei - snapshot.dailyRealizedYieldUsdWei,
    unrealizedYieldUsdWei:
      snapshot.unrealizedYieldUsdWei - snapshot.dailyUnrealizedYieldUsdWei,
  };
}

function nonNegativeDelta(current: bigint, baseline: bigint): bigint {
  const delta = current - baseline;
  return delta < ZERO ? ZERO : delta;
}

function buildSusdsYieldDailySnapshot({
  chainId,
  bucket,
  totals,
  deltaBaseline,
  sharePriceUsdWei,
  sampledAtBlock,
  sampledAtTimestamp,
}: {
  chainId: number;
  bucket: bigint;
  totals: SusdsYieldTotals;
  deltaBaseline: SusdsYieldDeltaBaseline;
  sharePriceUsdWei: bigint;
  sampledAtBlock: bigint;
  sampledAtTimestamp: bigint;
}): SusdsYieldDailySnapshot {
  return {
    id: susdsDailySnapshotId(chainId, bucket),
    chainId,
    token: SUSDS_ADDRESS,
    timestamp: bucket,
    ...totals,
    dailyEarnedYieldUsdWei: nonNegativeDelta(
      totals.totalEarnedYieldUsdWei,
      deltaBaseline.totalEarnedYieldUsdWei,
    ),
    dailyRealizedYieldUsdWei:
      totals.realizedYieldUsdWei - deltaBaseline.realizedYieldUsdWei,
    dailyUnrealizedYieldUsdWei:
      totals.unrealizedYieldUsdWei - deltaBaseline.unrealizedYieldUsdWei,
    sharePriceUsdWei,
    sampledAtBlock,
    sampledAtTimestamp,
  };
}

async function findPreviousDailySnapshot(
  context: SusdsContext,
  chainId: number,
  bucket: bigint,
): Promise<SusdsYieldDailySnapshot | undefined> {
  const launchBucket = dayBucket(V3_REVENUE_LAUNCH_TIMESTAMP);
  for (
    let previousBucket = bucket - SECONDS_PER_DAY;
    previousBucket >= launchBucket;
    previousBucket -= SECONDS_PER_DAY
  ) {
    const snapshot = await context.SusdsYieldDailySnapshot.get(
      susdsDailySnapshotId(chainId, previousBucket),
    );
    if (snapshot !== undefined) return snapshot;
  }
  return undefined;
}

export async function recordSusdsYieldDailySnapshot(
  context: SusdsContext,
  meta: BlockMeta,
  sharePriceUsdWei: bigint,
  precomputedTotals?: SusdsYieldTotals,
  options: SusdsYieldDailySnapshotOptions = {},
): Promise<boolean> {
  if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return false;

  const totals =
    precomputedTotals ??
    (await computeYieldTotals(context, meta, sharePriceUsdWei));
  if (
    options.allowZeroTotals !== true &&
    totals.currentShares === ZERO &&
    totals.totalEarnedYieldUsdWei === ZERO
  ) {
    return false;
  }

  const bucket = dayBucket(meta.blockTimestamp);
  const id = susdsDailySnapshotId(meta.chainId, bucket);
  const previousDayBucket = bucket - SECONDS_PER_DAY;
  const launchBucket = dayBucket(V3_REVENUE_LAUNCH_TIMESTAMP);
  const previousDaySnapshot =
    previousDayBucket >= launchBucket
      ? await context.SusdsYieldDailySnapshot.get(
          susdsDailySnapshotId(meta.chainId, previousDayBucket),
        )
      : undefined;
  const latestPriorSnapshot =
    previousDaySnapshot ??
    (await findPreviousDailySnapshot(context, meta.chainId, previousDayBucket));
  const currentSnapshot = await context.SusdsYieldDailySnapshot.get(id);

  if (
    options.requirePreviousDay === true &&
    currentSnapshot === undefined &&
    previousDaySnapshot === undefined &&
    bucket > launchBucket
  ) {
    return false;
  }

  const deltaBaseline =
    latestPriorSnapshot ??
    (currentSnapshot === undefined
      ? totals
      : baselineFromSameDaySnapshot(currentSnapshot));
  context.SusdsYieldDailySnapshot.set(
    buildSusdsYieldDailySnapshot({
      chainId: meta.chainId,
      bucket,
      totals,
      deltaBaseline,
      sharePriceUsdWei,
      sampledAtBlock: meta.blockNumber,
      sampledAtTimestamp: meta.blockTimestamp,
    }),
  );
  return true;
}

export async function recordSusdsYieldEventDailySnapshot(
  context: SusdsContext,
  meta: BlockMeta,
  sharePriceUsdWei: bigint,
  precomputedTotals?: SusdsYieldTotals,
): Promise<boolean> {
  return recordSusdsYieldDailySnapshot(
    context,
    meta,
    sharePriceUsdWei,
    precomputedTotals,
    { requirePreviousDay: true },
  );
}

/**
 * Write the launch baseline at the final pre-launch Ethereum block.
 *
 * The row uses the known v3 launch timestamp, but the share price read at the
 * preceding block. This makes launch-day earned yield zero and lets the first
 * later sampler preserve the full launch-to-sample delta.
 */
export async function recordSusdsYieldLaunchBaseline(
  context: SusdsContext,
  effectResults: SusdsHeartbeatEffectResults,
): Promise<boolean> {
  if (effectResults.blockTimestamp === null) return false;
  if (effectResults.sharePriceUsdWei === null) {
    throw new Error(
      `[sUSDS] convertToAssets(1e18) unavailable at launch block ${V3_REVENUE_LAUNCH_BLOCK}`,
    );
  }
  const meta: BlockMeta = {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
  };
  const totals = await computeYieldTotals(
    context,
    meta,
    effectResults.sharePriceUsdWei,
  );
  return recordSusdsYieldDailySnapshot(
    context,
    meta,
    effectResults.sharePriceUsdWei,
    totals,
    { allowZeroTotals: true },
  );
}

export async function readSharePrice(
  context: SusdsContext,
  meta: BlockMeta,
): Promise<bigint> {
  const sharePriceUsdWei = await context.effect(susdsSharePriceEffect, {
    chainId: meta.chainId,
    tokenAddress: SUSDS_ADDRESS,
    blockNumber: meta.blockNumber,
  });
  if (sharePriceUsdWei === null) {
    throw new Error(
      `[sUSDS] convertToAssets(1e18) unavailable at block ${meta.blockNumber}`,
    );
  }
  return sharePriceUsdWei;
}

export async function recordSusdsYieldHeartbeatSnapshot(
  context: SusdsContext,
  blockNumber: bigint,
  effectResults?: SusdsHeartbeatEffectResults,
): Promise<boolean> {
  const effects =
    effectResults ??
    (await readSusdsHeartbeatEffectResults(context, blockNumber));
  const { blockTimestamp } = effects;
  if (blockTimestamp === null || blockTimestamp <= 0n) return false;

  const meta: BlockMeta = {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber,
    blockTimestamp,
  };
  if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return false;

  const { sharePriceUsdWei } = effects;
  if (sharePriceUsdWei === null) {
    throw new Error(
      `[sUSDS] convertToAssets(1e18) unavailable at block ${meta.blockNumber}`,
    );
  }
  return recordSusdsYieldDailySnapshot(context, meta, sharePriceUsdWei);
}

async function readSusdsHeartbeatEffectResults(
  context: SusdsContext,
  blockNumber: bigint,
): Promise<SusdsHeartbeatEffectResults> {
  const meta = {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber,
  };
  const [blockTimestamp, sharePriceUsdWei] = await Promise.all([
    context.effect(blockTimestampEffect, meta),
    context.effect(susdsSharePriceEffect, {
      ...meta,
      tokenAddress: SUSDS_ADDRESS,
    }),
  ]);
  return { blockTimestamp, sharePriceUsdWei };
}

export async function handleSusdsYieldDailySnapshotHeartbeat({
  block,
  context,
}: {
  block: { number: number | bigint };
  context: SusdsContext;
}): Promise<boolean> {
  const effectResults = await readSusdsHeartbeatEffectResults(
    context,
    BigInt(block.number),
  );
  // preload-handler-note: raw block and share-price results are awaited before
  // this guard; the bounded sampler keeps snapshot work ordered.
  // preload-effect-helpers: recordSusdsYieldHeartbeatSnapshot
  if (context.isPreload) return false;
  return recordSusdsYieldHeartbeatSnapshot(
    context,
    BigInt(block.number),
    effectResults,
  );
}

export async function handleSusdsYieldLaunchBaseline({
  block,
  context,
}: {
  block: { number: number | bigint };
  context: SusdsContext;
}): Promise<boolean> {
  const blockNumber = BigInt(block.number);
  if (blockNumber !== BigInt(V3_REVENUE_LAUNCH_BLOCK)) return false;
  const effectResults = await readSusdsHeartbeatEffectResults(
    context,
    blockNumber,
  );
  // preload-handler-note: both dormant effects use the exact launch-block key
  // in preload and processing; no entity write occurs during preload.
  // preload-effect-helpers: recordSusdsYieldLaunchBaseline
  if (context.isPreload) return false;
  return recordSusdsYieldLaunchBaseline(context, effectResults);
}
