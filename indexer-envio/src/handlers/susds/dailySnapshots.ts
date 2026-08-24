import type { SusdsYieldDailySnapshot, SusdsYieldLaunchBaseline } from "envio";
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
  V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP,
  V3_REVENUE_LAUNCH_TIMESTAMP,
  ZERO,
  type BlockMeta,
  type SusdsContext,
  type SusdsYieldTotals,
} from "./shared.js";

function susdsDailySnapshotId(chainId: number, bucket: bigint): string {
  return `${chainId}-susds-${bucket}`;
}

function susdsLaunchBaselineId(chainId: number): string {
  return `${chainId}-susds-launch`;
}

type SusdsYieldDeltaBaseline = Pick<
  SusdsYieldDailySnapshot | SusdsYieldTotals,
  "totalEarnedYieldUsdWei" | "realizedYieldUsdWei" | "unrealizedYieldUsdWei"
>;

type SusdsYieldDailySnapshotOptions = {
  allowZeroTotals?: boolean;
};

type SusdsHeartbeatEffectResults = {
  blockTimestamp: bigint | null;
  sharePriceUsdWei: bigint | null;
};

function baselineFromSameDaySnapshot(
  snapshot: SusdsYieldDailySnapshot,
): SusdsYieldDeltaBaseline {
  const realizedYieldUsdWei =
    snapshot.realizedYieldUsdWei - snapshot.dailyRealizedYieldUsdWei;
  const unrealizedYieldUsdWei =
    snapshot.unrealizedYieldUsdWei - snapshot.dailyUnrealizedYieldUsdWei;
  return {
    totalEarnedYieldUsdWei: realizedYieldUsdWei + unrealizedYieldUsdWei,
    realizedYieldUsdWei,
    unrealizedYieldUsdWei,
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
  const validSharePriceUsdWei = requirePositiveSharePrice(
    sharePriceUsdWei,
    meta.blockNumber,
  );
  if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return false;

  const totals =
    precomputedTotals ??
    (await computeYieldTotals(context, meta, validSharePriceUsdWei));
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
      sharePriceUsdWei: validSharePriceUsdWei,
      sampledAtBlock: meta.blockNumber,
      sampledAtTimestamp: meta.blockTimestamp,
    }),
  );
  return true;
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
  requireLaunchBlockTimestamp(effectResults.blockTimestamp);
  const sharePriceUsdWei = requireSharePrice(
    effectResults.sharePriceUsdWei,
    BigInt(V3_REVENUE_LAUNCH_BLOCK),
  );
  const baselineId = susdsLaunchBaselineId(ETHEREUM_CHAIN_ID);
  const existingBaseline =
    await context.SusdsYieldLaunchBaseline.get(baselineId);
  if (existingBaseline !== undefined) {
    requireValidSusdsLaunchBaseline(existingBaseline);
    return false;
  }
  const meta: BlockMeta = {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
  };
  const totals = await computeYieldTotals(context, meta, sharePriceUsdWei);
  const didWrite = await recordSusdsYieldDailySnapshot(
    context,
    meta,
    sharePriceUsdWei,
    totals,
    { allowZeroTotals: true },
  );
  if (!didWrite) return false;
  context.SusdsYieldLaunchBaseline.set({
    id: baselineId,
    chainId: ETHEREUM_CHAIN_ID,
    token: SUSDS_ADDRESS,
    launchBlock: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    launchTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
    sharePriceUsdWei,
    sampledAtBlock: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    sampledAtTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
  });
  return true;
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
  return requireSharePrice(sharePriceUsdWei, meta.blockNumber);
}

function requireSharePrice(value: unknown, blockNumber: bigint): bigint {
  if (value === null) {
    throw new Error(
      `[sUSDS] convertToAssets(1e18) unavailable at block ${blockNumber}`,
    );
  }
  return requirePositiveSharePrice(value, blockNumber);
}

function requirePositiveSharePrice(
  value: unknown,
  blockNumber: bigint,
): bigint {
  if (typeof value !== "bigint" || value <= ZERO) {
    throw new Error(
      `[sUSDS] convertToAssets(1e18) returned an invalid share price at block ${blockNumber}`,
    );
  }
  return value;
}

function requireLaunchBlockTimestamp(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= ZERO) {
    throw new Error(
      `[sUSDS] launch block timestamp unavailable or invalid at block ${V3_REVENUE_LAUNCH_BLOCK}`,
    );
  }
  if (value !== V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP) {
    throw new Error(
      `[sUSDS] launch block timestamp ${value} does not match expected ${V3_REVENUE_LAUNCH_BLOCK_TIMESTAMP}`,
    );
  }
  return value;
}

async function hasSusdsLaunchBaseline(context: SusdsContext): Promise<boolean> {
  const baseline = await context.SusdsYieldLaunchBaseline.get(
    susdsLaunchBaselineId(ETHEREUM_CHAIN_ID),
  );
  if (baseline === undefined) return false;
  requireValidSusdsLaunchBaseline(baseline);
  return true;
}

function requireValidSusdsLaunchBaseline(
  baseline: SusdsYieldLaunchBaseline,
): void {
  if (
    baseline.chainId !== ETHEREUM_CHAIN_ID ||
    baseline.token !== SUSDS_ADDRESS ||
    baseline.launchBlock !== BigInt(V3_REVENUE_LAUNCH_BLOCK) ||
    baseline.launchTimestamp !== V3_REVENUE_LAUNCH_TIMESTAMP ||
    baseline.sampledAtBlock !== BigInt(V3_REVENUE_LAUNCH_BLOCK) ||
    baseline.sampledAtTimestamp !== V3_REVENUE_LAUNCH_TIMESTAMP
  ) {
    throw new Error(
      "[sUSDS] stored launch baseline metadata is invalid; sampler cannot continue",
    );
  }
  requirePositiveSharePrice(
    baseline.sharePriceUsdWei,
    BigInt(V3_REVENUE_LAUNCH_BLOCK),
  );
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
  if (blockTimestamp === null) return false;
  if (typeof blockTimestamp !== "bigint" || blockTimestamp <= ZERO) {
    throw new Error(
      `[sUSDS] block timestamp returned an invalid value at block ${blockNumber}`,
    );
  }

  const meta: BlockMeta = {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber,
    blockTimestamp,
  };
  if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return false;
  if (effects.sharePriceUsdWei === null) return false;

  const validSharePriceUsdWei = requireSharePrice(
    effects.sharePriceUsdWei,
    meta.blockNumber,
  );
  if (!(await hasSusdsLaunchBaseline(context))) return false;
  return recordSusdsYieldDailySnapshot(context, meta, validSharePriceUsdWei);
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
  // preload-handler-note: the launch-block predicate is phase-stable, and the
  // exact dormant effect reader runs with the same key in both phases.
  // preload-effect-helpers: readSusdsHeartbeatEffectResults
  if (context.isPreload) return false;
  return recordSusdsYieldLaunchBaseline(context, effectResults);
}
