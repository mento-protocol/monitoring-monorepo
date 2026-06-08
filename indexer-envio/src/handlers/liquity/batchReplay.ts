import type {
  BorrowerInfo,
  InterestRateBracket,
  LiquityInstance,
  PendingBatchMembershipOperation,
  PendingBatchedTroveUpdate,
  PendingRedemption,
  Trove,
} from "envio";
import { pendingTroveKey } from "./keys.js";
import { computeTroveIcrBps } from "./math.js";
import { OP } from "./operations.js";
import {
  TROVE_STATUS,
  applySystemDebtDelta,
  getOrCreateTrove,
  isPlaceholderClosedTrove,
  moveInterestRateBracketDebt,
  statusFromDebt,
  transitionTroveStatus,
} from "./troves.js";

type BatchReplayContext = {
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
  PendingBatchMembershipOperation: {
    get: (id: string) => Promise<PendingBatchMembershipOperation | undefined>;
    deleteUnsafe: (id: string) => void;
  };
  PendingBatchedTroveUpdate: {
    deleteUnsafe: (id: string) => void;
  };
  PendingRedemption: {
    get: (id: string) => Promise<PendingRedemption | undefined>;
    deleteUnsafe: (id: string) => void;
  };
};

type BatchReplayPending = Pick<
  PendingBatchedTroveUpdate,
  | "id"
  | "troveId"
  | "batchDebtShares"
  | "coll"
  | "stake"
  | "snapshotOfTotalCollRedist"
  | "snapshotOfTotalDebtRedist"
>;

type CollateralStatus =
  | { minDebt: bigint; systemParamsLoaded: boolean }
  | undefined;

const statusFromBatchReplay = (
  trove: Parameters<typeof isPlaceholderClosedTrove>[0] & { status: string },
  debt: bigint,
  collateral: CollateralStatus,
): string => {
  if (
    (trove.status === TROVE_STATUS.CLOSED &&
      !isPlaceholderClosedTrove(trove)) ||
    trove.status === TROVE_STATUS.LIQUIDATED
  ) {
    return trove.status;
  }
  if (debt === 0n) return TROVE_STATUS.REDEEMED;
  if (collateral?.systemParamsLoaded !== true) return TROVE_STATUS.ZOMBIE;
  return statusFromDebt(debt, collateral.minDebt);
};

async function moveBatchMembershipBracketDebt(
  context: BatchReplayContext,
  args: {
    collateralId: string;
    troveDebt: bigint;
    troveInterestRate: bigint;
    opAnnualInterestRate: bigint;
    leavesBatch: boolean;
    entersBatch: boolean;
    nextDebt: bigint;
    timestamp: bigint;
  },
): Promise<void> {
  if (args.entersBatch) {
    await moveInterestRateBracketDebt(context, {
      collateralId: args.collateralId,
      prevRate: args.troveInterestRate,
      nextRate: 0n,
      prevDebt: args.troveDebt,
      nextDebt: 0n,
      timestamp: args.timestamp,
    });
  } else if (args.leavesBatch) {
    await moveInterestRateBracketDebt(context, {
      collateralId: args.collateralId,
      prevRate: 0n,
      nextRate: args.opAnnualInterestRate,
      prevDebt: 0n,
      nextDebt: args.nextDebt,
      timestamp: args.timestamp,
    });
  }
}

export async function replayBatchedTroveUpdate(
  context: BatchReplayContext,
  args: {
    chainId: number;
    txHash: string;
    collateralId: string;
    batchId: string;
    pending: BatchReplayPending;
    blockNumber: bigint;
    blockTimestamp: bigint;
    batchDebt: bigint;
    totalDebtShares: bigint;
    annualInterestRate: bigint;
    price: bigint | null;
    collateral: CollateralStatus;
    instance: LiquityInstance;
  },
): Promise<LiquityInstance> {
  const { pending } = args;
  let trove = await getOrCreateTrove(context, {
    chainId: args.chainId,
    collateralId: args.collateralId,
    troveId: pending.troveId,
    blockNumber: args.blockNumber,
    blockTimestamp: args.blockTimestamp,
    txHash: args.txHash,
  });
  const prevTroveState = { status: trove.status, debt: trove.debt };
  const nextDebt =
    args.totalDebtShares === 0n
      ? 0n
      : (args.batchDebt * pending.batchDebtShares) / args.totalDebtShares;
  const pendingId = pendingTroveKey(
    args.chainId,
    args.txHash,
    args.collateralId,
    pending.troveId,
  );
  const [op, pendingRedemption] = await Promise.all([
    context.PendingBatchMembershipOperation.get(pendingId),
    context.PendingRedemption.get(pendingId),
  ]);
  if (op !== undefined) {
    context.PendingBatchMembershipOperation.deleteUnsafe(op.id);
  }
  const leavesBatch = op?.operation === OP.REMOVE_FROM_BATCH;
  const entersBatch = trove.interestBatchId === undefined && !leavesBatch;
  const movesLeaveDebt = leavesBatch && trove.interestBatchId !== undefined;
  await moveBatchMembershipBracketDebt(context, {
    collateralId: args.collateralId,
    troveDebt: trove.debt,
    troveInterestRate: trove.interestRate,
    opAnnualInterestRate: op?.annualInterestRate ?? 0n,
    leavesBatch: movesLeaveDebt,
    entersBatch,
    nextDebt,
    timestamp: args.blockTimestamp,
  });
  const transitioned = transitionTroveStatus(
    {
      ...trove,
      debt: nextDebt,
      coll: pending.coll,
      stake: pending.stake,
      snapshotOfTotalCollRedist: pending.snapshotOfTotalCollRedist,
      snapshotOfTotalDebtRedist: pending.snapshotOfTotalDebtRedist,
      interestRate: leavesBatch
        ? (op?.annualInterestRate ?? trove.interestRate)
        : args.annualInterestRate,
      interestBatchId: leavesBatch ? undefined : args.batchId,
      batchDebtShares: leavesBatch ? 0n : pending.batchDebtShares,
      icrBps: computeTroveIcrBps({
        coll: pending.coll,
        debt: nextDebt,
        price: args.price,
      }),
      lastUpdatedAt: args.blockTimestamp,
      lastUpdatedBlock: args.blockNumber,
    },
    statusFromBatchReplay(trove, nextDebt, args.collateral),
    args.instance,
  );
  trove = transitioned.trove;
  const instance = applySystemDebtDelta(transitioned.instance, prevTroveState, {
    status: trove.status,
    debt: trove.debt,
  });
  context.Trove.set(trove);
  context.PendingBatchedTroveUpdate.deleteUnsafe(pending.id);
  if (pendingRedemption !== undefined) {
    context.PendingRedemption.deleteUnsafe(pendingId);
  }
  return instance;
}
