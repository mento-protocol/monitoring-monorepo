import type { SusdsPosition } from "envio";
import {
  SUMMARY_ID,
  SUSDS_ADDRESS,
  TRACKED_SUSDS_WALLETS,
  ZERO,
  positionId,
  positiveDelta,
  valueForShares,
  type BlockMeta,
  type EventMeta,
  type SusdsContext,
  type SusdsYieldTotals,
} from "./shared.js";

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

export async function getPosition(
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

export function setPosition(
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

export function createLot(
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

export async function consumeLots(
  context: SusdsContext,
  wallet: string,
  shares: bigint,
  meta: EventMeta,
): Promise<bigint> {
  if (shares <= ZERO) return ZERO;

  const lots = await context.SusdsCostBasisLot.getWhere({
    chainId: { _eq: meta.chainId },
    wallet: { _eq: wallet },
  });
  const activeLots = lots
    .filter((lot) => lot.remainingShares > ZERO)
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

export async function updateSummary(
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

export async function computeYieldTotals(
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
