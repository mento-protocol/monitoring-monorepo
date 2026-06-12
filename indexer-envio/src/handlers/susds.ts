import type {
  EvmOnEventContext,
  SusdsPosition,
  SusdsYieldDailySnapshot,
} from "envio";
import { ZERO_ADDRESS } from "../constants.js";
import { SECONDS_PER_DAY, asAddress, dayBucket, eventId } from "../helpers.js";
import { indexer } from "../indexer.js";
import { susdsSharePriceEffect } from "../rpc/effects.js";

export const ETHEREUM_CHAIN_ID = 1;
export const SUSDS_ADDRESS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
export const TRACKED_SUSDS_WALLETS = [
  "0xd0697f70e79476195b742d5afab14be50f98cc1e",
  "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1",
] as const;

const WAD = 10n ** 18n;
const ZERO = 0n;
const SUMMARY_ID = `${ETHEREUM_CHAIN_ID}-susds`;
export const V3_REVENUE_LAUNCH_TIMESTAMP = 1_772_496_000n; // 2026-03-03T00:00:00Z
const SUSDS_DAILY_HEARTBEAT_BLOCK_INTERVAL = 300;
const TRACKED_WALLET_SET = new Set<string>(TRACKED_SUSDS_WALLETS);

const transferWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { from: address },
  { to: address },
]);
const depositWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { sender: address },
  { owner: address },
]);
const withdrawWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { sender: address },
  { receiver: address },
  { owner: address },
]);

type SusdsContext = Pick<
  EvmOnEventContext,
  | "SusdsCostBasisLot"
  | "SusdsPosition"
  | "SusdsYieldMovement"
  | "SusdsYieldDailySnapshot"
  | "SusdsYieldSummary"
  | "effect"
  | "isPreload"
>;

type BlockMeta = {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
};

type EventMeta = BlockMeta & {
  logIndex: number;
  txHash: string;
};

type SusdsYieldTotals = {
  currentShares: bigint;
  costBasisUsdWei: bigint;
  realizedYieldUsdWei: bigint;
  transferredOutYieldUsdWei: bigint;
  redeemedYieldUsdWei: bigint;
  currentValueUsdWei: bigint;
  unrealizedYieldUsdWei: bigint;
  totalEarnedYieldUsdWei: bigint;
};

function isTrackedWallet(address: string): boolean {
  return TRACKED_WALLET_SET.has(asAddress(address));
}

function positionId(chainId: number, wallet: string): string {
  return `${chainId}-${wallet}`;
}

function valueForShares(shares: bigint, sharePriceUsdWei: bigint): bigint {
  return (shares * sharePriceUsdWei) / WAD;
}

function positiveDelta(value: bigint, basis: bigint): bigint {
  return value > basis ? value - basis : ZERO;
}

function emptyPosition(
  chainId: number,
  wallet: string,
  meta: EventMeta,
): SusdsPosition {
  return {
    id: positionId(chainId, wallet),
    chainId,
    wallet,
    shares: ZERO,
    costBasisUsdWei: ZERO,
    realizedYieldUsdWei: ZERO,
    transferredOutYieldUsdWei: ZERO,
    redeemedYieldUsdWei: ZERO,
    lastUpdatedBlock: meta.blockNumber,
    lastUpdatedTimestamp: meta.blockTimestamp,
  };
}

async function getPosition(
  context: SusdsContext,
  chainId: number,
  wallet: string,
  meta: EventMeta,
): Promise<SusdsPosition> {
  return (
    (await context.SusdsPosition.get(positionId(chainId, wallet))) ??
    emptyPosition(chainId, wallet, meta)
  );
}

function setPosition(
  context: SusdsContext,
  position: SusdsPosition,
  meta: EventMeta,
): SusdsPosition {
  const next = {
    ...position,
    lastUpdatedBlock: meta.blockNumber,
    lastUpdatedTimestamp: meta.blockTimestamp,
  };
  context.SusdsPosition.set(next);
  return next;
}

function makeLotId(wallet: string, meta: EventMeta, suffix: string): string {
  return [
    meta.chainId,
    wallet,
    meta.blockNumber.toString(),
    meta.logIndex.toString(),
    suffix,
  ].join("-");
}

function createLot(
  context: SusdsContext,
  {
    wallet,
    shares,
    costBasisUsdWei,
    meta,
    suffix,
  }: {
    wallet: string;
    shares: bigint;
    costBasisUsdWei: bigint;
    meta: EventMeta;
    suffix: string;
  },
): void {
  if (shares <= ZERO) return;
  context.SusdsCostBasisLot.set({
    id: makeLotId(wallet, meta, suffix),
    chainId: meta.chainId,
    wallet,
    originalShares: shares,
    remainingShares: shares,
    costBasisUsdWei,
    openedAtBlock: meta.blockNumber,
    openedAtLogIndex: meta.logIndex,
    openedTxHash: meta.txHash,
    updatedAtBlock: meta.blockNumber,
    updatedAtTimestamp: meta.blockTimestamp,
  });
}

async function consumeLots(
  context: SusdsContext,
  wallet: string,
  shares: bigint,
  meta: EventMeta,
): Promise<bigint> {
  if (shares <= ZERO) return ZERO;

  const lots = await context.SusdsCostBasisLot.getWhere({
    wallet: { _eq: wallet },
  });
  const activeLots = lots
    .filter((lot) => lot.chainId === meta.chainId && lot.remainingShares > ZERO)
    .sort((a, b) => {
      if (a.openedAtBlock !== b.openedAtBlock) {
        return a.openedAtBlock < b.openedAtBlock ? -1 : 1;
      }
      if (a.openedAtLogIndex !== b.openedAtLogIndex) {
        return a.openedAtLogIndex - b.openedAtLogIndex;
      }
      return a.id.localeCompare(b.id);
    });

  let remaining = shares;
  let consumedBasis = ZERO;
  for (const lot of activeLots) {
    if (remaining === ZERO) break;
    const take =
      lot.remainingShares <= remaining ? lot.remainingShares : remaining;
    const basis =
      take === lot.remainingShares
        ? lot.costBasisUsdWei
        : (lot.costBasisUsdWei * take) / lot.remainingShares;
    remaining -= take;
    consumedBasis += basis;
    context.SusdsCostBasisLot.set({
      ...lot,
      remainingShares: lot.remainingShares - take,
      costBasisUsdWei: lot.costBasisUsdWei - basis,
      updatedAtBlock: meta.blockNumber,
      updatedAtTimestamp: meta.blockTimestamp,
    });
  }

  if (remaining > ZERO) {
    throw new Error(
      `[sUSDS] insufficient cost-basis lots for ${wallet}: ` +
        `needed ${shares}, missing ${remaining}. Check start_block and tracked wallets.`,
    );
  }

  return consumedBasis;
}

async function updateSummary(
  context: SusdsContext,
  meta: EventMeta,
  sharePriceUsdWei: bigint,
): Promise<SusdsYieldTotals> {
  const totals = await computeYieldTotals(context, meta, sharePriceUsdWei);
  context.SusdsYieldSummary.set({
    id: SUMMARY_ID,
    chainId: meta.chainId,
    token: SUSDS_ADDRESS,
    trackedWallets: [...TRACKED_SUSDS_WALLETS],
    ...totals,
    sharePriceUsdWei,
    lastMovementTxHash: meta.txHash,
    lastUpdatedBlock: meta.blockNumber,
    lastUpdatedTimestamp: meta.blockTimestamp,
  });
  return totals;
}

async function computeYieldTotals(
  context: SusdsContext,
  meta: BlockMeta,
  sharePriceUsdWei: bigint,
): Promise<SusdsYieldTotals> {
  let currentShares = ZERO;
  let costBasisUsdWei = ZERO;
  let realizedYieldUsdWei = ZERO;
  let transferredOutYieldUsdWei = ZERO;
  let redeemedYieldUsdWei = ZERO;

  for (const wallet of TRACKED_SUSDS_WALLETS) {
    const position = await context.SusdsPosition.get(
      positionId(meta.chainId, wallet),
    );
    if (!position) continue;
    currentShares += position.shares;
    costBasisUsdWei += position.costBasisUsdWei;
    realizedYieldUsdWei += position.realizedYieldUsdWei;
    transferredOutYieldUsdWei += position.transferredOutYieldUsdWei;
    redeemedYieldUsdWei += position.redeemedYieldUsdWei;
  }

  const currentValueUsdWei = valueForShares(currentShares, sharePriceUsdWei);
  const unrealizedYieldUsdWei = positiveDelta(
    currentValueUsdWei,
    costBasisUsdWei,
  );
  return {
    currentShares,
    costBasisUsdWei,
    realizedYieldUsdWei,
    transferredOutYieldUsdWei,
    redeemedYieldUsdWei,
    currentValueUsdWei,
    unrealizedYieldUsdWei,
    totalEarnedYieldUsdWei: realizedYieldUsdWei + unrealizedYieldUsdWei,
  };
}

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
    dailyEarnedYieldUsdWei:
      totals.totalEarnedYieldUsdWei - deltaBaseline.totalEarnedYieldUsdWei,
    dailyRealizedYieldUsdWei:
      totals.realizedYieldUsdWei - deltaBaseline.realizedYieldUsdWei,
    dailyUnrealizedYieldUsdWei:
      totals.unrealizedYieldUsdWei - deltaBaseline.unrealizedYieldUsdWei,
    sharePriceUsdWei,
    sampledAtBlock,
    sampledAtTimestamp,
  };
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
  const previousSnapshot = await context.SusdsYieldDailySnapshot.get(
    susdsDailySnapshotId(meta.chainId, bucket - SECONDS_PER_DAY),
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

async function readSharePrice(
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

async function shouldProcess(
  context: SusdsContext,
  movementId: string,
): Promise<boolean> {
  return (await context.SusdsYieldMovement.get(movementId)) === undefined;
}

async function recordDeposit(
  context: SusdsContext,
  meta: EventMeta,
  owner: string,
  assets: bigint,
  shares: bigint,
  sharePriceUsdWei: bigint,
): Promise<void> {
  const position = await getPosition(context, meta.chainId, owner, meta);
  createLot(context, {
    wallet: owner,
    shares,
    costBasisUsdWei: assets,
    meta,
    suffix: "deposit",
  });
  setPosition(
    context,
    {
      ...position,
      shares: position.shares + shares,
      costBasisUsdWei: position.costBasisUsdWei + assets,
    },
    meta,
  );
  context.SusdsYieldMovement.set({
    id: eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex),
    chainId: meta.chainId,
    kind: "deposit",
    from: ZERO_ADDRESS,
    to: owner,
    shares,
    assetsUsdWei: assets,
    costBasisUsdWei: assets,
    yieldUsdWei: ZERO,
    sharePriceUsdWei,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    blockTimestamp: meta.blockTimestamp,
  });
}

async function recordWithdraw(
  context: SusdsContext,
  meta: EventMeta,
  {
    owner,
    receiver,
    assets,
    shares,
    sharePriceUsdWei,
  }: {
    owner: string;
    receiver: string;
    assets: bigint;
    shares: bigint;
    sharePriceUsdWei: bigint;
  },
): Promise<void> {
  const costBasisUsdWei = await consumeLots(context, owner, shares, meta);
  const yieldUsdWei = positiveDelta(assets, costBasisUsdWei);
  const position = await getPosition(context, meta.chainId, owner, meta);
  if (position.shares < shares || position.costBasisUsdWei < costBasisUsdWei) {
    throw new Error(`[sUSDS] withdrawal exceeds tracked position for ${owner}`);
  }
  setPosition(
    context,
    {
      ...position,
      shares: position.shares - shares,
      costBasisUsdWei: position.costBasisUsdWei - costBasisUsdWei,
      realizedYieldUsdWei: position.realizedYieldUsdWei + yieldUsdWei,
      redeemedYieldUsdWei: position.redeemedYieldUsdWei + yieldUsdWei,
    },
    meta,
  );
  context.SusdsYieldMovement.set({
    id: eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex),
    chainId: meta.chainId,
    kind: "withdraw",
    from: owner,
    to: receiver,
    shares,
    assetsUsdWei: assets,
    costBasisUsdWei,
    yieldUsdWei,
    sharePriceUsdWei,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    blockTimestamp: meta.blockTimestamp,
  });
}

async function recordTransfer(
  context: SusdsContext,
  meta: EventMeta,
  from: string,
  to: string,
  shares: bigint,
  sharePriceUsdWei: bigint,
): Promise<void> {
  const fromTracked = isTrackedWallet(from);
  const toTracked = isTrackedWallet(to);
  const assetsUsdWei = valueForShares(shares, sharePriceUsdWei);
  let kind = "transfer_in";
  let costBasisUsdWei = assetsUsdWei;
  let yieldUsdWei = ZERO;

  if (fromTracked && toTracked) {
    kind = "internal_transfer";
    costBasisUsdWei = await consumeLots(context, from, shares, meta);
    const fromPosition = await getPosition(context, meta.chainId, from, meta);
    const toPosition = await getPosition(context, meta.chainId, to, meta);
    if (
      fromPosition.shares < shares ||
      fromPosition.costBasisUsdWei < costBasisUsdWei
    ) {
      throw new Error(`[sUSDS] internal transfer exceeds position for ${from}`);
    }
    setPosition(
      context,
      {
        ...fromPosition,
        shares: fromPosition.shares - shares,
        costBasisUsdWei: fromPosition.costBasisUsdWei - costBasisUsdWei,
      },
      meta,
    );
    createLot(context, {
      wallet: to,
      shares,
      costBasisUsdWei,
      meta,
      suffix: "internal",
    });
    setPosition(
      context,
      {
        ...toPosition,
        shares: toPosition.shares + shares,
        costBasisUsdWei: toPosition.costBasisUsdWei + costBasisUsdWei,
      },
      meta,
    );
  } else if (fromTracked) {
    kind = "transfer_out";
    costBasisUsdWei = await consumeLots(context, from, shares, meta);
    yieldUsdWei = positiveDelta(assetsUsdWei, costBasisUsdWei);
    const position = await getPosition(context, meta.chainId, from, meta);
    if (
      position.shares < shares ||
      position.costBasisUsdWei < costBasisUsdWei
    ) {
      throw new Error(`[sUSDS] transfer out exceeds position for ${from}`);
    }
    setPosition(
      context,
      {
        ...position,
        shares: position.shares - shares,
        costBasisUsdWei: position.costBasisUsdWei - costBasisUsdWei,
        realizedYieldUsdWei: position.realizedYieldUsdWei + yieldUsdWei,
        transferredOutYieldUsdWei:
          position.transferredOutYieldUsdWei + yieldUsdWei,
      },
      meta,
    );
  } else if (toTracked) {
    createLot(context, {
      wallet: to,
      shares,
      costBasisUsdWei,
      meta,
      suffix: "transfer-in",
    });
    const position = await getPosition(context, meta.chainId, to, meta);
    setPosition(
      context,
      {
        ...position,
        shares: position.shares + shares,
        costBasisUsdWei: position.costBasisUsdWei + costBasisUsdWei,
      },
      meta,
    );
  } else {
    return;
  }

  context.SusdsYieldMovement.set({
    id: eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex),
    chainId: meta.chainId,
    kind,
    from,
    to,
    shares,
    assetsUsdWei,
    costBasisUsdWei,
    yieldUsdWei,
    sharePriceUsdWei,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    blockTimestamp: meta.blockTimestamp,
  });
}

function eventMeta(event: {
  chainId: number;
  block: { number: number; timestamp: number };
  logIndex: number;
  transaction: { hash: string };
}): EventMeta {
  return {
    chainId: event.chainId,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  };
}

indexer.onEvent(
  {
    contract: "Susds",
    event: "Deposit",
    where: () => ({ params: depositWhereParams }),
  },
  async ({ event, context }) => {
    const meta = eventMeta(event);
    const owner = asAddress(event.params.owner);
    if (!isTrackedWallet(owner)) return;
    const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    const sharePriceUsdWei = await readSharePrice(context, meta);
    await recordDeposit(
      context,
      meta,
      owner,
      event.params.assets,
      event.params.shares,
      sharePriceUsdWei,
    );
    const totals = await updateSummary(context, meta, sharePriceUsdWei);
    await recordSusdsYieldDailySnapshot(
      context,
      meta,
      sharePriceUsdWei,
      totals,
    );
  },
);

indexer.onEvent(
  {
    contract: "Susds",
    event: "Withdraw",
    where: () => ({ params: withdrawWhereParams }),
  },
  async ({ event, context }) => {
    const meta = eventMeta(event);
    const owner = asAddress(event.params.owner);
    if (!isTrackedWallet(owner)) return;
    const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    const sharePriceUsdWei = await readSharePrice(context, meta);
    await recordWithdraw(context, meta, {
      owner,
      receiver: asAddress(event.params.receiver),
      assets: event.params.assets,
      shares: event.params.shares,
      sharePriceUsdWei,
    });
    const totals = await updateSummary(context, meta, sharePriceUsdWei);
    await recordSusdsYieldDailySnapshot(
      context,
      meta,
      sharePriceUsdWei,
      totals,
    );
  },
);

indexer.onEvent(
  {
    contract: "Susds",
    event: "Transfer",
    where: () => ({ params: transferWhereParams }),
  },
  async ({ event, context }) => {
    const from = asAddress(event.params.from);
    const to = asAddress(event.params.to);
    if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) return;
    if (from === to) return;
    const meta = eventMeta(event);
    const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    const sharePriceUsdWei = await readSharePrice(context, meta);
    await recordTransfer(
      context,
      meta,
      from,
      to,
      event.params.value,
      sharePriceUsdWei,
    );
    const totals = await updateSummary(context, meta, sharePriceUsdWei);
    await recordSusdsYieldDailySnapshot(
      context,
      meta,
      sharePriceUsdWei,
      totals,
    );
  },
);

type BlockWithTimestamp = {
  readonly number: number;
  readonly timestamp?: number;
};

indexer.onBlock(
  {
    name: "SusdsYieldDailySnapshotHeartbeat",
    where: ({ chain }) =>
      chain.id === ETHEREUM_CHAIN_ID
        ? {
            block: {
              number: {
                _gte: chain.startBlock,
                _every: SUSDS_DAILY_HEARTBEAT_BLOCK_INTERVAL,
              },
            },
          }
        : false,
  },
  async ({ block, context }) => {
    if (context.isPreload) return;
    const blockWithTimestamp = block as BlockWithTimestamp;
    const timestamp = blockWithTimestamp.timestamp;
    if (timestamp === undefined || timestamp <= 0) return;
    const meta: BlockMeta = {
      chainId: ETHEREUM_CHAIN_ID,
      blockNumber: BigInt(block.number),
      blockTimestamp: BigInt(timestamp),
    };
    if (meta.blockTimestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return;
    const sharePriceUsdWei = await readSharePrice(context, meta);
    await recordSusdsYieldDailySnapshot(context, meta, sharePriceUsdWei);
  },
);
