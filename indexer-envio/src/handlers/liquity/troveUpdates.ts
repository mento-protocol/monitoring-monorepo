import type { PendingBatchMembershipOperation, Trove } from "envio";
import { OP } from "./operations.js";
import {
  moveInterestRateBracketDebt,
  tracksIndividualInterest,
} from "./troves.js";

type PendingBatchOperation = Pick<PendingBatchMembershipOperation, "operation">;

type TroveUpdatedBracketContext = Parameters<
  typeof moveInterestRateBracketDebt
>[0];

export const removesFromBatch = (
  pendingBatchOperation: PendingBatchOperation | undefined,
): boolean => pendingBatchOperation?.operation === OP.REMOVE_FROM_BATCH;

export async function moveTroveUpdatedInterestRateBracketDebt(
  context: TroveUpdatedBracketContext,
  args: {
    collateralId: string;
    trove: Trove;
    pendingBatchOperation: PendingBatchOperation | undefined;
    annualInterestRate: bigint;
    debt: bigint;
    timestamp: bigint;
  },
): Promise<void> {
  if (removesFromBatch(args.pendingBatchOperation)) {
    await moveInterestRateBracketDebt(context, {
      collateralId: args.collateralId,
      prevRate: 0n,
      nextRate: args.annualInterestRate,
      prevDebt: 0n,
      nextDebt: args.debt,
      timestamp: args.timestamp,
    });
    return;
  }

  if (tracksIndividualInterest(args.trove)) {
    await moveInterestRateBracketDebt(context, {
      collateralId: args.collateralId,
      prevRate: args.trove.interestRate,
      nextRate: args.annualInterestRate,
      prevDebt: args.trove.debt,
      nextDebt: args.debt,
      timestamp: args.timestamp,
    });
  }
}

export function applyTroveUpdatedFields(
  trove: Trove,
  args: {
    debt: bigint;
    coll: bigint;
    stake: bigint;
    snapshotOfTotalCollRedist: bigint;
    snapshotOfTotalDebtRedist: bigint;
    annualInterestRate: bigint;
    icrBps: number;
    blockTimestamp: bigint;
    blockNumber: bigint;
    txHash: string;
    pendingBatchOperation: PendingBatchOperation | undefined;
  },
): Trove {
  const leavesBatch = removesFromBatch(args.pendingBatchOperation);
  return {
    ...trove,
    debt: args.debt,
    coll: args.coll,
    stake: args.stake,
    snapshotOfTotalCollRedist: args.snapshotOfTotalCollRedist,
    snapshotOfTotalDebtRedist: args.snapshotOfTotalDebtRedist,
    interestRate: args.annualInterestRate,
    interestBatchId: leavesBatch ? undefined : trove.interestBatchId,
    batchDebtShares: leavesBatch ? 0n : trove.batchDebtShares,
    icrBps: args.icrBps,
    lastUpdatedAt: args.blockTimestamp,
    lastUpdatedBlock: args.blockNumber,
    lastUpdatedTxHash: args.txHash,
  };
}
