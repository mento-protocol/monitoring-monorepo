import type { PendingBatchMembershipOperation, Trove } from "envio";
import { pendingTroveKey } from "./keys.js";
import { preloadLiquityMarket } from "./bootstrap.js";
import {
  preloadBorrowingFeeAppliedEvent,
  preloadBorrowingRevenueRollover,
  preloadBorrowingUpfrontFeeBucket,
} from "./borrowingRevenue.js";
import type { LiquityMarketConfig } from "./config.js";
import { loadLiquityPrice } from "./priceFeed.js";
import { OP, isBatchMembershipOperation } from "./operations.js";
import {
  setPendingBatchMembershipOperation,
  setPendingRedemption,
} from "./pendingOperations.js";
import { preloadSystemParams } from "./systemParams.js";
import type {
  PendingBatchedTroveUpdateRow,
  TroveManagerPreloadContext,
  TroveOperationPreloadContext,
} from "./troveManagerPreloadContext.js";
import { makeTroveId, preloadInterestRateBracketDebt } from "./troves.js";

export function isPendingBatchReplayRow(
  pending: PendingBatchedTroveUpdateRow,
  args: {
    collateralId: string;
    batchManager: string;
    eventLogIndex: number;
  },
): boolean {
  return (
    pending.collateralId === args.collateralId &&
    pending.batchManager === args.batchManager &&
    pending.logIndex < args.eventLogIndex
  );
}

export function isPendingBatchRemovalForBatch(
  pending: PendingBatchMembershipOperation,
  args: { collateralId: string; batchId: string },
): boolean {
  return (
    pending.collateralId === args.collateralId &&
    pending.operation === OP.REMOVE_FROM_BATCH &&
    pending.interestBatchId === args.batchId
  );
}

async function preloadTroveAndMarket(
  context: TroveManagerPreloadContext,
  market: LiquityMarketConfig,
  collateralId: string,
  troveId: string,
): Promise<Trove | undefined> {
  const [, trove] = await Promise.all([
    preloadLiquityMarket(context, market),
    context.Trove.get(makeTroveId(collateralId, troveId)),
  ]);
  return trove;
}

export async function preloadTroveOperation(
  context: TroveOperationPreloadContext,
  args: {
    market: LiquityMarketConfig;
    chainId: number;
    txHash: string;
    collateralId: string;
    troveId: string;
    operation: number;
    annualInterestRate: bigint;
    upfrontFee: bigint;
    appliedFeeEventId: string;
    blockNumber: bigint;
    blockTimestamp: bigint;
  },
): Promise<void> {
  const [trove] = await Promise.all([
    preloadTroveAndMarket(
      context,
      args.market,
      args.collateralId,
      args.troveId,
    ),
    preloadBorrowingUpfrontFeeBucket(
      context,
      args.collateralId,
      args.upfrontFee,
      args.blockTimestamp,
    ),
    preloadBorrowingFeeAppliedEvent(
      context,
      args.appliedFeeEventId,
      args.upfrontFee,
    ),
  ]);
  if (args.operation === OP.REDEEM_COLLATERAL) {
    setPendingRedemption(context, {
      ...args,
      timestamp: args.blockTimestamp,
    });
  } else if (isBatchMembershipOperation(args.operation)) {
    setPendingBatchMembershipOperation(context, {
      ...args,
      operation: args.operation,
      interestBatchId: trove?.interestBatchId,
      timestamp: args.blockTimestamp,
    });
  }
}

export async function preloadBatchReplay(args: {
  context: TroveManagerPreloadContext;
  market: LiquityMarketConfig;
  chainId: number;
  txHash: string;
  collateralId: string;
  batchManager: string;
  eventLogIndex: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  upfrontFee: bigint;
  appliedFeeEventId: string;
  prevBatchRate: bigint;
  nextBatchRate: bigint;
  prevBatchDebt: bigint;
  nextBatchDebt: bigint;
  totalDebtShares: bigint;
}): Promise<void> {
  const pendingRows = await args.context.PendingBatchedTroveUpdate.getWhere({
    txHash: { _eq: args.txHash },
  });
  const pendingBatchOps =
    await args.context.PendingBatchMembershipOperation.getWhere({
      txHash: { _eq: args.txHash },
    });
  const relevantRows = pendingRows.filter((pending) =>
    isPendingBatchReplayRow(pending, args),
  );
  await Promise.all([
    preloadLiquityMarket(args.context, args.market),
    preloadSystemParams(args.context, args.market),
    loadLiquityPrice(args.context, args.market, args.blockNumber),
    preloadBorrowingRevenueRollover(
      args.context,
      args.collateralId,
      args.blockTimestamp,
    ),
    preloadBorrowingUpfrontFeeBucket(
      args.context,
      args.collateralId,
      args.upfrontFee,
      args.blockTimestamp,
    ),
    preloadBorrowingFeeAppliedEvent(
      args.context,
      args.appliedFeeEventId,
      args.upfrontFee,
    ),
    preloadInterestRateBracketDebt(args.context, {
      collateralId: args.collateralId,
      prevRate: args.prevBatchRate,
      nextRate: args.nextBatchRate,
      prevDebt: args.prevBatchDebt,
      nextDebt: args.nextBatchDebt,
      untilTimestamp: args.blockTimestamp,
    }),
    ...relevantRows.map(async (pending) => {
      const pendingId = pendingTroveKey(
        args.chainId,
        args.txHash,
        args.collateralId,
        pending.troveId,
      );
      const [trove, op] = await Promise.all([
        args.context.Trove.get(makeTroveId(args.collateralId, pending.troveId)),
        args.context.PendingBatchMembershipOperation.get(pendingId),
        args.context.PendingRedemption.get(pendingId),
      ]);
      if (trove === undefined) return;
      const leavesBatch = op?.operation === OP.REMOVE_FROM_BATCH;
      const entersBatch = trove.interestBatchId === undefined && !leavesBatch;
      const batchShareDebt =
        args.totalDebtShares === 0n
          ? 0n
          : (args.nextBatchDebt * pending.batchDebtShares) /
            args.totalDebtShares;
      const nextDebt = leavesBatch ? trove.debt : batchShareDebt;
      if (entersBatch) {
        await preloadInterestRateBracketDebt(args.context, {
          collateralId: args.collateralId,
          prevRate: trove.interestRate,
          nextRate: 0n,
          prevDebt: trove.debt,
          nextDebt: 0n,
          untilTimestamp: args.blockTimestamp,
        });
      } else if (leavesBatch && trove.interestBatchId !== undefined) {
        await preloadInterestRateBracketDebt(args.context, {
          collateralId: args.collateralId,
          prevRate: 0n,
          nextRate: op.annualInterestRate,
          prevDebt: 0n,
          nextDebt,
          untilTimestamp: args.blockTimestamp,
        });
      }
    }),
    ...pendingBatchOps
      .filter((pending) =>
        isPendingBatchRemovalForBatch(pending, {
          collateralId: args.collateralId,
          batchId: `${args.collateralId}-${args.batchManager}`,
        }),
      )
      .map((pending) =>
        args.context.PendingBatchMembershipOperation.get(pending.id),
      ),
  ]);
}
