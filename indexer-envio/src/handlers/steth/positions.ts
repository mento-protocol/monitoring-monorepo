import type { StethPosition } from "envio";
import {
  STETH_ADDRESS,
  SUMMARY_ID,
  TRACKED_STETH_WALLETS,
  ZERO,
  positionId,
  positiveDelta,
  type EventMeta,
  type StethContext,
  type StethYieldTotals,
} from "./shared.js";

function emptyPosition(
  chainId: number,
  wallet: string,
  meta: EventMeta,
): StethPosition {
  return {
    id: positionId(chainId, wallet),
    chainId,
    wallet,
    balance: ZERO,
    principalAmount: ZERO,
    realizedYieldAmount: ZERO,
    transferredOutYieldAmount: ZERO,
    lastUpdatedBlock: meta.blockNumber,
    lastUpdatedTimestamp: meta.blockTimestamp,
  };
}

export async function getPosition(
  context: StethContext,
  chainId: number,
  wallet: string,
  meta: EventMeta,
): Promise<StethPosition> {
  return (
    (await context.StethPosition.get(positionId(chainId, wallet))) ??
    emptyPosition(chainId, wallet, meta)
  );
}

export function setPosition(
  context: StethContext,
  position: StethPosition,
  meta: EventMeta,
): StethPosition {
  const next = {
    ...position,
    lastUpdatedBlock: meta.blockNumber,
    lastUpdatedTimestamp: meta.blockTimestamp,
  };
  context.StethPosition.set(next);
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
  context: StethContext,
  {
    wallet,
    amount,
    meta,
    suffix,
  }: {
    wallet: string;
    amount: bigint;
    meta: EventMeta;
    suffix: string;
  },
): void {
  if (amount <= ZERO) return;
  context.StethCostBasisLot.set({
    id: makeLotId(wallet, meta, suffix),
    chainId: meta.chainId,
    wallet,
    originalAmount: amount,
    remainingAmount: amount,
    openedAtBlock: meta.blockNumber,
    openedAtLogIndex: meta.logIndex,
    openedTxHash: meta.txHash,
    updatedAtBlock: meta.blockNumber,
    updatedAtTimestamp: meta.blockTimestamp,
  });
}

export async function consumePrincipalLots(
  context: StethContext,
  wallet: string,
  amount: bigint,
  meta: EventMeta,
): Promise<bigint> {
  if (amount <= ZERO) return ZERO;

  const lots = await context.StethCostBasisLot.getWhere({
    wallet: { _eq: wallet },
  });
  const activeLots = lots
    .filter((lot) => lot.chainId === meta.chainId && lot.remainingAmount > ZERO)
    .sort((a, b) => {
      if (a.openedAtBlock !== b.openedAtBlock) {
        return a.openedAtBlock < b.openedAtBlock ? -1 : 1;
      }
      if (a.openedAtLogIndex !== b.openedAtLogIndex) {
        return a.openedAtLogIndex - b.openedAtLogIndex;
      }
      return a.id.localeCompare(b.id);
    });

  let remaining = amount;
  let consumedPrincipal = ZERO;
  for (const lot of activeLots) {
    if (remaining === ZERO) break;
    const take =
      lot.remainingAmount <= remaining ? lot.remainingAmount : remaining;
    remaining -= take;
    consumedPrincipal += take;
    context.StethCostBasisLot.set({
      ...lot,
      remainingAmount: lot.remainingAmount - take,
      updatedAtBlock: meta.blockNumber,
      updatedAtTimestamp: meta.blockTimestamp,
    });
  }

  return consumedPrincipal;
}

export async function updateSummary(
  context: StethContext,
  meta: EventMeta,
): Promise<StethYieldTotals> {
  const totals = await computeYieldTotals(context, meta);
  context.StethYieldSummary.set({
    id: SUMMARY_ID,
    chainId: meta.chainId,
    token: STETH_ADDRESS,
    trackedWallets: [...TRACKED_STETH_WALLETS],
    ...totals,
    lastMovementTxHash: meta.txHash,
    lastUpdatedBlock: meta.blockNumber,
    lastUpdatedTimestamp: meta.blockTimestamp,
  });
  return totals;
}

export async function computeYieldTotals(
  context: StethContext,
  meta: Pick<EventMeta, "chainId">,
): Promise<StethYieldTotals> {
  let currentBalance = ZERO;
  let remainingPrincipalAmount = ZERO;
  let realizedYieldAmount = ZERO;
  let transferredOutYieldAmount = ZERO;

  for (const wallet of TRACKED_STETH_WALLETS) {
    const position = await context.StethPosition.get(
      positionId(meta.chainId, wallet),
    );
    if (!position) continue;
    currentBalance += position.balance;
    remainingPrincipalAmount += position.principalAmount;
    realizedYieldAmount += position.realizedYieldAmount;
    transferredOutYieldAmount += position.transferredOutYieldAmount;
  }

  const unrealizedYieldAmount = positiveDelta(
    currentBalance,
    remainingPrincipalAmount,
  );
  return {
    currentBalance,
    remainingPrincipalAmount,
    realizedYieldAmount,
    transferredOutYieldAmount,
    unrealizedYieldAmount,
    totalEarnedYieldAmount: realizedYieldAmount + unrealizedYieldAmount,
  };
}
