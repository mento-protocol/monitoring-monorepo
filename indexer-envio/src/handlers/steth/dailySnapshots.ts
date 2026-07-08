import type { StethWalletLaunchBaseline, StethYieldDailySnapshot } from "envio";
import { SECONDS_PER_DAY, dayBucket } from "../../helpers.js";
import {
  blockTimestampEffect,
  stethBalanceOfEffect,
} from "../../rpc/effects.js";
import { createLot, getPosition, setPosition } from "./positions.js";
import {
  ETHEREUM_CHAIN_ID,
  STETH_ADDRESS,
  TRACKED_STETH_WALLETS,
  V3_REVENUE_LAUNCH_BLOCK,
  V3_REVENUE_LAUNCH_TIMESTAMP,
  ZERO,
  positionId,
  positiveDelta,
  type BlockMeta,
  type EventMeta,
  type StethContext,
} from "./shared.js";

type StethWalletYieldTotals = {
  balanceAmount: bigint;
  principalAmount: bigint;
  realizedYieldAmount: bigint;
  transferredOutYieldAmount: bigint;
  unrealizedYieldAmount: bigint;
  totalEarnedYieldAmount: bigint;
};

type StethYieldDeltaBaseline = Pick<
  StethYieldDailySnapshot | StethWalletYieldTotals,
  "totalEarnedYieldAmount" | "realizedYieldAmount" | "unrealizedYieldAmount"
>;

type StethDailySnapshotOptions = {
  requirePreviousDay?: boolean;
};

function stethWalletLaunchBaselineId(chainId: number, wallet: string): string {
  return `${chainId}-steth-${wallet}-launch`;
}

function stethDailySnapshotId(
  chainId: number,
  wallet: string,
  bucket: bigint,
): string {
  return `${chainId}-steth-${wallet}-${bucket}`;
}

function subtractFloor(value: bigint, amount: bigint): bigint {
  return value > amount ? value - amount : ZERO;
}

function nonNegativeDelta(current: bigint, baseline: bigint): bigint {
  const delta = current - baseline;
  return delta < ZERO ? ZERO : delta;
}

function baselineFromSameDaySnapshot(
  snapshot: StethYieldDailySnapshot,
): StethYieldDeltaBaseline {
  return {
    totalEarnedYieldAmount:
      snapshot.totalEarnedYieldAmount - snapshot.dailyEarnedYieldAmount,
    realizedYieldAmount:
      snapshot.realizedYieldAmount - snapshot.dailyRealizedYieldAmount,
    unrealizedYieldAmount:
      snapshot.unrealizedYieldAmount - snapshot.dailyUnrealizedYieldAmount,
  };
}

function zeroDeltaBaseline(): StethYieldDeltaBaseline {
  return {
    totalEarnedYieldAmount: ZERO,
    realizedYieldAmount: ZERO,
    unrealizedYieldAmount: ZERO,
  };
}

function buildStethYieldDailySnapshot({
  chainId,
  wallet,
  bucket,
  totals,
  deltaBaseline,
  sampledAtBlock,
  sampledAtTimestamp,
}: {
  chainId: number;
  wallet: string;
  bucket: bigint;
  totals: StethWalletYieldTotals;
  deltaBaseline: StethYieldDeltaBaseline;
  sampledAtBlock: bigint;
  sampledAtTimestamp: bigint;
}): StethYieldDailySnapshot {
  return {
    id: stethDailySnapshotId(chainId, wallet, bucket),
    chainId,
    token: STETH_ADDRESS,
    wallet,
    timestamp: bucket,
    ...totals,
    dailyEarnedYieldAmount: nonNegativeDelta(
      totals.totalEarnedYieldAmount,
      deltaBaseline.totalEarnedYieldAmount,
    ),
    dailyRealizedYieldAmount:
      totals.realizedYieldAmount - deltaBaseline.realizedYieldAmount,
    dailyUnrealizedYieldAmount:
      totals.unrealizedYieldAmount - deltaBaseline.unrealizedYieldAmount,
    sampledAtBlock,
    sampledAtTimestamp,
  };
}

async function findPreviousDailySnapshot(
  context: StethContext,
  chainId: number,
  wallet: string,
  bucket: bigint,
): Promise<StethYieldDailySnapshot | undefined> {
  const launchBucket = dayBucket(V3_REVENUE_LAUNCH_TIMESTAMP);
  for (
    let previousBucket = bucket - SECONDS_PER_DAY;
    previousBucket >= launchBucket;
    previousBucket -= SECONDS_PER_DAY
  ) {
    const snapshot = await context.StethYieldDailySnapshot.get(
      stethDailySnapshotId(chainId, wallet, previousBucket),
    );
    if (snapshot !== undefined) return snapshot;
  }
  return undefined;
}

async function readStethBalance(
  context: StethContext,
  meta: Pick<BlockMeta, "chainId" | "blockNumber">,
  wallet: string,
): Promise<bigint | null> {
  return context.effect(stethBalanceOfEffect, {
    chainId: meta.chainId,
    tokenAddress: STETH_ADDRESS,
    account: wallet,
    blockNumber: meta.blockNumber,
  });
}

async function readAllTrackedBalances(
  context: StethContext,
  meta: BlockMeta,
): Promise<Map<string, bigint> | null> {
  const balances = new Map<string, bigint>();
  for (const wallet of TRACKED_STETH_WALLETS) {
    const balance = await readStethBalance(context, meta, wallet);
    if (balance === null) return null;
    balances.set(wallet, balance);
  }
  return balances;
}

async function walletTotals(
  context: StethContext,
  meta: BlockMeta,
  wallet: string,
  balanceAmount: bigint,
): Promise<StethWalletYieldTotals | null> {
  const baseline = await context.StethWalletLaunchBaseline.get(
    stethWalletLaunchBaselineId(meta.chainId, wallet),
  );
  if (!baseline) return null;

  const position = await context.StethPosition.get(
    positionId(meta.chainId, wallet),
  );
  const principalAmount = position?.principalAmount ?? ZERO;
  const realizedYieldAmount = subtractFloor(
    position?.realizedYieldAmount ?? ZERO,
    baseline.realizedYieldAmountAtLaunch,
  );
  const transferredOutYieldAmount = subtractFloor(
    position?.transferredOutYieldAmount ?? ZERO,
    baseline.transferredOutYieldAmountAtLaunch,
  );
  const unrealizedYieldAmount = positiveDelta(balanceAmount, principalAmount);

  return {
    balanceAmount,
    principalAmount,
    realizedYieldAmount,
    transferredOutYieldAmount,
    unrealizedYieldAmount,
    totalEarnedYieldAmount: realizedYieldAmount + unrealizedYieldAmount,
  };
}

async function buildWalletSnapshot(
  context: StethContext,
  meta: BlockMeta,
  wallet: string,
  totals: StethWalletYieldTotals,
  options: StethDailySnapshotOptions,
): Promise<StethYieldDailySnapshot | null> {
  const bucket = dayBucket(meta.blockTimestamp);
  const id = stethDailySnapshotId(meta.chainId, wallet, bucket);
  const previousDayBucket = bucket - SECONDS_PER_DAY;
  const launchBucket = dayBucket(V3_REVENUE_LAUNCH_TIMESTAMP);
  const previousDaySnapshot =
    previousDayBucket >= launchBucket
      ? await context.StethYieldDailySnapshot.get(
          stethDailySnapshotId(meta.chainId, wallet, previousDayBucket),
        )
      : undefined;
  const latestPriorSnapshot =
    previousDaySnapshot ??
    (await findPreviousDailySnapshot(
      context,
      meta.chainId,
      wallet,
      previousDayBucket,
    ));
  const currentSnapshot = await context.StethYieldDailySnapshot.get(id);

  if (
    options.requirePreviousDay === true &&
    currentSnapshot === undefined &&
    previousDaySnapshot === undefined &&
    bucket > launchBucket
  ) {
    return null;
  }

  const deltaBaseline =
    latestPriorSnapshot ??
    (currentSnapshot === undefined
      ? zeroDeltaBaseline()
      : baselineFromSameDaySnapshot(currentSnapshot));

  return buildStethYieldDailySnapshot({
    chainId: meta.chainId,
    wallet,
    bucket,
    totals,
    deltaBaseline,
    sampledAtBlock: meta.blockNumber,
    sampledAtTimestamp: meta.blockTimestamp,
  });
}

export async function recordStethYieldDailySnapshots(
  context: StethContext,
  meta: BlockMeta,
  options: StethDailySnapshotOptions = {},
): Promise<boolean> {
  if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return false;

  const balances = await readAllTrackedBalances(context, meta);
  if (balances === null) return false;

  const totalsByWallet = new Map<string, StethWalletYieldTotals>();
  for (const wallet of TRACKED_STETH_WALLETS) {
    const balance = balances.get(wallet);
    if (balance === undefined) return false;
    const totals = await walletTotals(context, meta, wallet, balance);
    if (totals === null) return false;
    totalsByWallet.set(wallet, totals);
  }

  const snapshots: StethYieldDailySnapshot[] = [];
  for (const wallet of TRACKED_STETH_WALLETS) {
    const totals = totalsByWallet.get(wallet);
    if (totals === undefined) return false;
    const snapshot = await buildWalletSnapshot(
      context,
      meta,
      wallet,
      totals,
      options,
    );
    if (snapshot === null) return false;
    snapshots.push(snapshot);
  }
  for (const snapshot of snapshots) {
    context.StethYieldDailySnapshot.set(snapshot);
  }
  return snapshots.length > 0;
}

export async function recordStethYieldEventDailySnapshots(
  context: StethContext,
  meta: EventMeta,
): Promise<boolean> {
  return recordStethYieldDailySnapshots(context, meta, {
    requirePreviousDay: true,
  });
}

function launchBaselineMeta(sampledAtTimestamp: bigint): EventMeta {
  return {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    blockTimestamp: sampledAtTimestamp,
    logIndex: -1,
    txHash: "steth-launch-baseline",
  };
}

function buildLaunchBaseline({
  wallet,
  balanceAmount,
  principalTopUpAmount,
  position,
  sampledAtTimestamp,
}: {
  wallet: string;
  balanceAmount: bigint;
  principalTopUpAmount: bigint;
  position: {
    realizedYieldAmount: bigint;
    transferredOutYieldAmount: bigint;
  };
  sampledAtTimestamp: bigint;
}): StethWalletLaunchBaseline {
  return {
    id: stethWalletLaunchBaselineId(ETHEREUM_CHAIN_ID, wallet),
    chainId: ETHEREUM_CHAIN_ID,
    token: STETH_ADDRESS,
    wallet,
    launchBlock: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    launchTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
    balanceAmount,
    principalTopUpAmount,
    realizedYieldAmountAtLaunch: position.realizedYieldAmount,
    transferredOutYieldAmountAtLaunch: position.transferredOutYieldAmount,
    sampledAtBlock: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    sampledAtTimestamp,
  };
}

async function hasAllStethWalletLaunchBaselines(
  context: StethContext,
): Promise<boolean> {
  for (const wallet of TRACKED_STETH_WALLETS) {
    const baseline = await context.StethWalletLaunchBaseline.get(
      stethWalletLaunchBaselineId(ETHEREUM_CHAIN_ID, wallet),
    );
    if (baseline === undefined) return false;
  }
  return true;
}

async function ensureStethWalletLaunchBaselines(
  context: StethContext,
): Promise<boolean> {
  return hasAllStethWalletLaunchBaselines(context);
}

export async function recordStethWalletLaunchBaselines(
  context: StethContext,
  sampledAtTimestamp: bigint,
): Promise<boolean> {
  const meta = launchBaselineMeta(sampledAtTimestamp);
  const balances = await readAllTrackedBalances(context, meta);
  if (balances === null) {
    throw new Error(
      "[stETH] launch baseline balanceOf unavailable; failing launch block so Envio retries before post-launch movements.",
    );
  }

  let didWrite = false;
  for (const wallet of TRACKED_STETH_WALLETS) {
    const balanceAmount = balances.get(wallet);
    if (balanceAmount === undefined) return false;

    const baselineId = stethWalletLaunchBaselineId(ETHEREUM_CHAIN_ID, wallet);
    if (
      (await context.StethWalletLaunchBaseline.get(baselineId)) !== undefined
    ) {
      continue;
    }

    const position = await getPosition(
      context,
      ETHEREUM_CHAIN_ID,
      wallet,
      meta,
    );
    const principalTopUpAmount = positiveDelta(balanceAmount, position.balance);
    if (principalTopUpAmount > ZERO) {
      createLot(context, {
        wallet,
        amount: principalTopUpAmount,
        meta,
        suffix: "launch-baseline",
      });
    }
    const nextPosition = setPosition(
      context,
      {
        ...position,
        balance: balanceAmount,
        principalAmount: position.principalAmount + principalTopUpAmount,
      },
      meta,
    );

    context.StethWalletLaunchBaseline.set(
      buildLaunchBaseline({
        wallet,
        balanceAmount,
        principalTopUpAmount,
        position: nextPosition,
        sampledAtTimestamp,
      }),
    );
    didWrite = true;
  }

  const launchMeta: BlockMeta = {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber: BigInt(V3_REVENUE_LAUNCH_BLOCK),
    blockTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
  };
  await recordStethYieldDailySnapshots(context, launchMeta);
  return didWrite;
}

export async function recordStethYieldHeartbeatSnapshots(
  context: StethContext,
  blockNumber: bigint,
): Promise<boolean> {
  const blockTimestamp = await context.effect(blockTimestampEffect, {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber,
  });
  if (blockTimestamp === null || blockTimestamp <= ZERO) return false;

  const meta: BlockMeta = {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber,
    blockTimestamp,
  };
  if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return false;
  if (!(await ensureStethWalletLaunchBaselines(context))) return false;

  return recordStethYieldDailySnapshots(context, meta);
}

export async function handleStethLaunchBaseline({
  block,
  context,
}: {
  block: { number: number | bigint };
  context: StethContext;
}): Promise<boolean> {
  if (context.isPreload) return false;
  const blockNumber = BigInt(block.number);
  if (blockNumber !== BigInt(V3_REVENUE_LAUNCH_BLOCK)) return false;

  const sampledAtTimestamp = await context.effect(blockTimestampEffect, {
    chainId: ETHEREUM_CHAIN_ID,
    blockNumber,
  });
  if (sampledAtTimestamp === null || sampledAtTimestamp <= ZERO) return false;
  return recordStethWalletLaunchBaselines(context, sampledAtTimestamp);
}

export async function handleStethYieldDailySnapshotHeartbeat({
  block,
  context,
}: {
  block: { number: number | bigint };
  context: StethContext;
}): Promise<boolean> {
  if (context.isPreload) return false;
  return recordStethYieldHeartbeatSnapshots(context, BigInt(block.number));
}
