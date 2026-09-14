import type { Trove } from "envio";
import {
  moveInterestRateBracketDebt,
  tracksIndividualInterest,
} from "./troves.js";

type TroveBracketContext = Parameters<typeof moveInterestRateBracketDebt>[0];

/** A batch-managed trove's debt lives in its batch's bracket, so this skips
 * it. For `REMOVE_FROM_BATCH` this event fires before `TroveOperation(9)`
 * while the trove still reads as batch-managed; `exitInterestBatch` moves
 * the debt at that operation. */
export async function moveTroveUpdatedInterestRateBracketDebt(
  context: TroveBracketContext,
  args: {
    chainId: number;
    collateralId: string;
    trove: Trove;
    annualInterestRate: bigint;
    debt: bigint;
    timestamp: bigint;
    blockNumber: bigint;
  },
): Promise<void> {
  if (!tracksIndividualInterest(args.trove)) return;
  await moveInterestRateBracketDebt(context, {
    chainId: args.chainId,
    collateralId: args.collateralId,
    prevRate: args.trove.interestRate,
    nextRate: args.annualInterestRate,
    prevDebt: args.trove.debt,
    nextDebt: args.debt,
    timestamp: args.timestamp,
    blockNumber: args.blockNumber,
  });
}

/** Batch exit for `REMOVE_FROM_BATCH` (op 9), applied by its
 * `TroveOperation`. `TroveManager.onRemoveFromBatch` emits the ordinary
 * `TroveUpdated` (full individual debt and rate) first, then
 * `TroveOperation(9)`, then the exit `BatchUpdated`, and no
 * `BatchedTroveUpdated`. When this runs, the entity already holds the
 * individual debt and rate but still reads as batch-managed, so
 * `TroveUpdated` skipped the bracket move. Move that debt into the
 * individual-rate bracket and clear the batch fields. A trove already
 * outside a batch is returned unchanged, so its debt is not counted twice. */
export async function exitInterestBatch(
  context: TroveBracketContext,
  args: {
    chainId: number;
    collateralId: string;
    trove: Trove;
    timestamp: bigint;
    blockNumber: bigint;
  },
): Promise<Trove> {
  const { trove } = args;
  if (tracksIndividualInterest(trove)) return trove;
  await moveInterestRateBracketDebt(context, {
    chainId: args.chainId,
    collateralId: args.collateralId,
    prevRate: 0n,
    nextRate: trove.interestRate,
    prevDebt: 0n,
    nextDebt: trove.debt,
    timestamp: args.timestamp,
    blockNumber: args.blockNumber,
  });
  return { ...trove, interestBatchId: undefined, batchDebtShares: 0n };
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
  },
): Trove {
  return {
    ...trove,
    debt: args.debt,
    coll: args.coll,
    stake: args.stake,
    snapshotOfTotalCollRedist: args.snapshotOfTotalCollRedist,
    snapshotOfTotalDebtRedist: args.snapshotOfTotalDebtRedist,
    interestRate: args.annualInterestRate,
    icrBps: args.icrBps,
    lastUpdatedAt: args.blockTimestamp,
    lastUpdatedBlock: args.blockNumber,
    lastUpdatedTxHash: args.txHash,
  };
}
