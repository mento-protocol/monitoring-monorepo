import type { SusdsYieldDailySnapshot } from "envio";
import { SECONDS_PER_DAY, dayBucket } from "../../helpers.js";
import { susdsSharePriceEffect } from "../../rpc/effects.js";
import { computeYieldTotals } from "./positions.js";
import {
  SUSDS_ADDRESS,
  V3_REVENUE_LAUNCH_TIMESTAMP,
  WAD,
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
): Promise<void> {
  if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return;

  const totals =
    precomputedTotals ??
    (await computeYieldTotals(context, meta, sharePriceUsdWei));
  if (totals.currentShares === ZERO && totals.totalEarnedYieldUsdWei === ZERO) {
    return;
  }

  const bucket = dayBucket(meta.blockTimestamp);
  const id = susdsDailySnapshotId(meta.chainId, bucket);
  const previousSnapshot = await findPreviousDailySnapshot(
    context,
    meta.chainId,
    bucket,
  );
  const currentSnapshot =
    previousSnapshot === undefined
      ? await context.SusdsYieldDailySnapshot.get(id)
      : undefined;
  const deltaBaseline =
    previousSnapshot ??
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
}

export async function readSharePrice(
  context: SusdsContext,
  meta: BlockMeta,
  fallbackSharePriceUsdWei?: bigint | null,
): Promise<bigint> {
  const sharePriceUsdWei = await readSharePriceOrNull(
    context,
    meta,
    fallbackSharePriceUsdWei,
  );
  if (sharePriceUsdWei !== null) return sharePriceUsdWei;
  throw new Error(
    `[sUSDS] convertToAssets(1e18) unavailable at block ${meta.blockNumber}`,
  );
}

async function readSharePriceOrNull(
  context: SusdsContext,
  meta: BlockMeta,
  fallbackSharePriceUsdWei?: bigint | null,
): Promise<bigint | null> {
  let sharePriceUsdWei: bigint | null;
  try {
    sharePriceUsdWei = await context.effect(susdsSharePriceEffect, {
      chainId: meta.chainId,
      tokenAddress: SUSDS_ADDRESS,
      blockNumber: meta.blockNumber,
    });
  } catch {
    sharePriceUsdWei = null;
  }
  return sharePriceUsdWei ?? fallbackSharePriceUsdWei ?? null;
}

export function sharePriceFromAssetsAndShares(
  assets: bigint,
  shares: bigint,
): bigint | null {
  if (shares <= ZERO) return null;
  return (assets * WAD) / shares;
}
