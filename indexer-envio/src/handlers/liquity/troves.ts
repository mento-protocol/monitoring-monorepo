import type {
  BorrowerInfo,
  InterestRateBracket,
  LiquityInstance,
  Trove,
} from "envio";
import { ZERO_ADDRESS } from "../../constants.js";
import { asAddress } from "../../helpers.js";
import { debtTimesRateD36, floorInterestRateBracket } from "./math.js";

export const TROVE_STATUS = {
  ACTIVE: "active",
  ZOMBIE: "zombie",
  CLOSED: "closed",
  LIQUIDATED: "liquidated",
  REDEEMED: "redeemed",
} as const;

type TroveContext = {
  Trove: {
    get: (id: string) => Promise<Trove | undefined>;
    set: (entity: Trove) => void;
  };
  BorrowerInfo: {
    get: (id: string) => Promise<BorrowerInfo | undefined>;
    set: (entity: BorrowerInfo) => void;
  };
  InterestRateBracket: {
    get: (id: string) => Promise<InterestRateBracket | undefined>;
    set: (entity: InterestRateBracket) => void;
  };
};

export const makeTroveId = (
  collateralId: string,
  troveId: bigint | string,
): string =>
  `${collateralId}-${typeof troveId === "bigint" ? troveId.toString(16) : troveId}`;

export const normalizeTroveTokenId = (troveId: bigint | string): string =>
  typeof troveId === "bigint" ? `0x${troveId.toString(16)}` : troveId;

export const isActiveStatus = (status: string): boolean =>
  status === TROVE_STATUS.ACTIVE;

export const transitionTroveStatus = (
  trove: Trove,
  nextStatus: string,
  instance: LiquityInstance,
): { trove: Trove; instance: LiquityInstance } => {
  if (trove.status === nextStatus) return { trove, instance };
  const wasActive = isActiveStatus(trove.status);
  const isActive = isActiveStatus(nextStatus);
  return {
    trove: { ...trove, status: nextStatus },
    instance: {
      ...instance,
      activeTroveCount:
        instance.activeTroveCount + (isActive ? 1 : 0) - (wasActive ? 1 : 0),
    },
  };
};

export const statusFromDebt = (debt: bigint, minDebt: bigint): string => {
  if (debt === 0n) return TROVE_STATUS.REDEEMED;
  if (minDebt > 0n && debt < minDebt) return TROVE_STATUS.ZOMBIE;
  return TROVE_STATUS.ACTIVE;
};

export const tracksIndividualInterest = (
  trove: Pick<Trove, "interestBatchId">,
): boolean => trove.interestBatchId === undefined;

export const isPlaceholderClosedTrove = (
  trove: Pick<Trove, "status" | "closedAt" | "closedAtBlock" | "closedTxHash">,
): boolean =>
  trove.status === TROVE_STATUS.CLOSED &&
  trove.closedAt === undefined &&
  trove.closedAtBlock === undefined &&
  trove.closedTxHash === undefined;

export const makePlaceholderTrove = ({
  id,
  chainId,
  collateralId,
  troveId,
  blockNumber,
  blockTimestamp,
  txHash,
}: {
  id: string;
  chainId: number;
  collateralId: string;
  troveId: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  txHash: string;
}): Trove => ({
  id,
  chainId,
  collateralId,
  troveId,
  owner: ZERO_ADDRESS,
  previousOwner: ZERO_ADDRESS,
  status: TROVE_STATUS.CLOSED,
  debt: 0n,
  coll: 0n,
  stake: 0n,
  snapshotOfTotalCollRedist: 0n,
  snapshotOfTotalDebtRedist: 0n,
  interestRate: 0n,
  interestBatchId: undefined,
  batchDebtShares: 0n,
  icrBps: 0,
  liquidatedColl: undefined,
  liquidatedDebt: undefined,
  collSurplus: undefined,
  priceAtLiquidation: undefined,
  redemptionCount: 0,
  redeemedColl: 0n,
  redeemedDebt: 0n,
  redemptionFeePaidCum: 0n,
  openedAt: blockTimestamp,
  openedAtBlock: blockNumber,
  openedTxHash: txHash,
  closedAt: undefined,
  closedAtBlock: undefined,
  closedTxHash: undefined,
  lastUserActionAt: 0n,
  lastUpdatedAt: blockTimestamp,
  lastUpdatedBlock: blockNumber,
});

export async function getOrCreateTrove(
  context: TroveContext,
  args: {
    chainId: number;
    collateralId: string;
    troveId: bigint | string;
    blockNumber: bigint;
    blockTimestamp: bigint;
    txHash: string;
  },
): Promise<Trove> {
  const tokenId = normalizeTroveTokenId(args.troveId);
  const id = makeTroveId(args.collateralId, tokenId);
  const existing = await context.Trove.get(id);
  return (
    existing ??
    makePlaceholderTrove({
      id,
      chainId: args.chainId,
      collateralId: args.collateralId,
      troveId: tokenId,
      blockNumber: args.blockNumber,
      blockTimestamp: args.blockTimestamp,
      txHash: args.txHash,
    })
  );
}

const parseCounts = (items: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const [id, count] = item.split(":");
    if (id !== undefined && count !== undefined) counts.set(id, Number(count));
  }
  return counts;
};

const serializeCounts = (counts: Map<string, number>): string[] =>
  [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${id}:${count}`);

export async function updateBorrowerCount(
  context: TroveContext,
  chainId: number,
  address: string,
  collateralId: string,
  delta: 1 | -1,
): Promise<void> {
  const normalized = asAddress(address);
  if (normalized === ZERO_ADDRESS) return;
  const id = `${chainId}-${normalized}`;
  const existing = await context.BorrowerInfo.get(id);
  const counts = parseCounts(existing?.trovesByCollateral ?? []);
  counts.set(
    collateralId,
    Math.max(0, (counts.get(collateralId) ?? 0) + delta),
  );
  const nextTroves = Math.max(0, (existing?.troves ?? 0) + delta);
  context.BorrowerInfo.set({
    id,
    chainId,
    address: normalized,
    troves: nextTroves,
    trovesByCollateral: serializeCounts(counts),
  });
}

export async function moveInterestRateBracketDebt(
  context: TroveContext,
  args: {
    collateralId: string;
    prevRate: bigint;
    nextRate: bigint;
    prevDebt: bigint;
    nextDebt: bigint;
    timestamp: bigint;
  },
): Promise<void> {
  await applyBracketDelta(
    context,
    args.collateralId,
    args.prevRate,
    -args.prevDebt,
    args.timestamp,
  );
  await applyBracketDelta(
    context,
    args.collateralId,
    args.nextRate,
    args.nextDebt,
    args.timestamp,
  );
}

async function applyBracketDelta(
  context: TroveContext,
  collateralId: string,
  rawRate: bigint,
  debtDelta: bigint,
  timestamp: bigint,
): Promise<void> {
  if (rawRate === 0n || debtDelta === 0n) return;
  const rate = floorInterestRateBracket(rawRate);
  const id = `${collateralId}-${rate}`;
  const existing = await context.InterestRateBracket.get(id);
  const bracket = existing ?? {
    id,
    collateralId,
    rate,
    totalDebt: 0n,
    sumDebtTimesRateD36: 0n,
    pendingDebtTimesOneYearD36: 0n,
    updatedAt: timestamp,
  };
  const elapsed =
    timestamp > bracket.updatedAt ? timestamp - bracket.updatedAt : 0n;
  const pending =
    bracket.pendingDebtTimesOneYearD36 + bracket.sumDebtTimesRateD36 * elapsed;
  const totalDebt = bracket.totalDebt + debtDelta;
  const sumDebtTimesRateD36 =
    bracket.sumDebtTimesRateD36 + debtTimesRateD36(debtDelta, rate);
  context.InterestRateBracket.set({
    ...bracket,
    totalDebt: totalDebt > 0n ? totalDebt : 0n,
    sumDebtTimesRateD36: sumDebtTimesRateD36 > 0n ? sumDebtTimesRateD36 : 0n,
    pendingDebtTimesOneYearD36: pending,
    updatedAt: timestamp,
  });
}

type ReclassifyTrovesContext = {
  LiquityInstance: {
    get: (id: string) => Promise<LiquityInstance | undefined>;
    set: (entity: LiquityInstance) => void;
  };
  Trove: {
    set: (entity: Trove) => void;
    getWhere: (args: { collateralId: { _eq: string } }) => Promise<Trove[]>;
  };
};

export async function reclassifyTrovesForLoadedParams(
  context: ReclassifyTrovesContext,
  collateralId: string,
  minDebt: bigint,
  minBoldInSp: bigint,
): Promise<void> {
  const instance = await context.LiquityInstance.get(collateralId);
  if (instance === undefined) return;
  let nextInstance =
    instance.spHeadroom === -1n
      ? { ...instance, spHeadroom: instance.spDeposits - minBoldInSp }
      : instance;
  const troves = await context.Trove.getWhere({
    collateralId: { _eq: collateralId },
  });
  for (const status of [TROVE_STATUS.ACTIVE, TROVE_STATUS.ZOMBIE]) {
    for (const trove of troves) {
      if (trove.status !== status) continue;
      const nextStatus = statusFromDebt(trove.debt, minDebt);
      const transitioned = transitionTroveStatus(
        trove,
        nextStatus,
        nextInstance,
      );
      if (transitioned.trove !== trove) context.Trove.set(transitioned.trove);
      nextInstance = transitioned.instance;
    }
  }
  if (nextInstance !== instance) context.LiquityInstance.set(nextInstance);
}
