import type { LiquityInstance, Trove } from "envio";
import { negativeToPositive } from "./math.js";
import { OP, isBatchMembershipOperation } from "./operations.js";
import {
  setPendingBatchMembershipOperation,
  setPendingRedemption,
} from "./pendingOperations.js";
import {
  TROVE_STATUS,
  statusFromCollateral,
  transitionTroveStatus,
} from "./troves.js";

export const isForcedOperation = (op: number): boolean =>
  op === OP.REDEEM_COLLATERAL ||
  op === OP.LIQUIDATE ||
  op === OP.APPLY_PENDING_DEBT;

export function transitionOpenedTrove(
  trove: Trove,
  instance: LiquityInstance,
  args: { blockTimestamp: bigint; blockNumber: bigint; txHash: string },
): { trove: Trove; instance: LiquityInstance } {
  const transitioned = transitionTroveStatus(
    {
      ...trove,
      openedAt: trove.openedAt === 0n ? args.blockTimestamp : trove.openedAt,
      openedAtBlock:
        trove.openedAtBlock === 0n ? args.blockNumber : trove.openedAtBlock,
      openedTxHash: trove.openedTxHash || args.txHash,
    },
    TROVE_STATUS.ACTIVE,
    instance,
  );
  return {
    trove: transitioned.trove,
    instance: {
      ...transitioned.instance,
      troveOpenedCountBucket: transitioned.instance.troveOpenedCountBucket + 1,
      troveOpenedCountDayBucket:
        transitioned.instance.troveOpenedCountDayBucket + 1,
    },
  };
}

export function transitionClosedTrove(
  trove: Trove,
  instance: LiquityInstance,
  args: { blockTimestamp: bigint; blockNumber: bigint; txHash: string },
): { trove: Trove; instance: LiquityInstance } {
  const transitioned = transitionTroveStatus(
    {
      ...trove,
      closedAt: args.blockTimestamp,
      closedAtBlock: args.blockNumber,
      closedTxHash: args.txHash,
    },
    TROVE_STATUS.CLOSED,
    instance,
  );
  return {
    trove: transitioned.trove,
    instance: {
      ...transitioned.instance,
      troveClosedCountBucket: transitioned.instance.troveClosedCountBucket + 1,
      troveClosedCountDayBucket:
        transitioned.instance.troveClosedCountDayBucket + 1,
    },
  };
}

export function transitionLiquidatedTrove(
  trove: Trove,
  instance: LiquityInstance,
  args: {
    collChange: bigint;
    debtChange: bigint;
    blockTimestamp: bigint;
    blockNumber: bigint;
    txHash: string;
  },
): { trove: Trove; instance: LiquityInstance } {
  const transitioned = transitionTroveStatus(
    {
      ...trove,
      liquidatedColl: negativeToPositive(args.collChange),
      liquidatedDebt: negativeToPositive(args.debtChange),
      closedAt: args.blockTimestamp,
      closedAtBlock: args.blockNumber,
      closedTxHash: args.txHash,
    },
    TROVE_STATUS.LIQUIDATED,
    instance,
  );
  return {
    trove: transitioned.trove,
    instance: {
      ...transitioned.instance,
      liqCountCum: transitioned.instance.liqCountCum + 1,
      liqCountBucket: transitioned.instance.liqCountBucket + 1,
      liqCountDayBucket: transitioned.instance.liqCountDayBucket + 1,
    },
  };
}

/** Apply the operation-specific trove/instance transition for a
 *  `TroveOperation` event and stage the pending rows (redemption, batch
 *  membership) that later same-tx events consume. Ops with no status
 *  effect (adjustments, interest-rate changes, APPLY_PENDING_DEBT) pass
 *  trove and instance through unchanged. */
export async function applyTroveOperationTransition(
  context: {
    LiquityCollateral: {
      get: (
        id: string,
      ) => Promise<
        { minDebt: bigint; systemParamsLoaded: boolean } | undefined
      >;
    };
  } & Parameters<typeof setPendingRedemption>[0] &
    Parameters<typeof setPendingBatchMembershipOperation>[0],
  trove: Trove,
  instance: LiquityInstance,
  args: {
    op: number;
    chainId: number;
    txHash: string;
    collateralId: string;
    annualInterestRate: bigint;
    collChange: bigint;
    debtChange: bigint;
    blockTimestamp: bigint;
    blockNumber: bigint;
  },
): Promise<{ trove: Trove; instance: LiquityInstance }> {
  const { op, blockTimestamp, blockNumber, txHash } = args;
  if (op === OP.OPEN_TROVE || op === OP.OPEN_TROVE_AND_JOIN_BATCH) {
    return transitionOpenedTrove(trove, instance, {
      blockTimestamp,
      blockNumber,
      txHash,
    });
  }
  if (op === OP.CLOSE_TROVE) {
    return transitionClosedTrove(trove, instance, {
      blockTimestamp,
      blockNumber,
      txHash,
    });
  }
  if (op === OP.LIQUIDATE) {
    return transitionLiquidatedTrove(trove, instance, {
      collChange: args.collChange,
      debtChange: args.debtChange,
      blockTimestamp,
      blockNumber,
      txHash,
    });
  }
  if (op === OP.REDEEM_COLLATERAL) {
    const redeemed = {
      ...trove,
      redemptionCount: trove.redemptionCount + 1,
      redeemedColl: trove.redeemedColl + negativeToPositive(args.collChange),
      redeemedDebt: trove.redeemedDebt + negativeToPositive(args.debtChange),
    };
    const collateral = await context.LiquityCollateral.get(args.collateralId);
    const transitioned = transitionTroveStatus(
      redeemed,
      statusFromCollateral(redeemed.debt, collateral),
      instance,
    );
    setPendingRedemption(context, {
      chainId: args.chainId,
      txHash,
      collateralId: args.collateralId,
      troveId: redeemed.troveId,
      timestamp: blockTimestamp,
      blockNumber,
    });
    return transitioned;
  }
  if (isBatchMembershipOperation(op)) {
    setPendingBatchMembershipOperation(context, {
      chainId: args.chainId,
      txHash,
      collateralId: args.collateralId,
      troveId: trove.troveId,
      operation: op,
      annualInterestRate: args.annualInterestRate,
      interestBatchId: trove.interestBatchId,
      timestamp: blockTimestamp,
      blockNumber,
    });
  }
  return { trove, instance };
}
