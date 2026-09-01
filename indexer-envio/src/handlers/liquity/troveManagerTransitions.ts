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

type TroveOperationTransitionContext = {
  LiquityCollateral: {
    get: (
      id: string,
    ) => Promise<{ minDebt: bigint; systemParamsLoaded: boolean } | undefined>;
  };
} & Parameters<typeof setPendingRedemption>[0] &
  Parameters<typeof setPendingBatchMembershipOperation>[0];

/** Per-op state transition for one `TroveOperation` event: open/close/
 * liquidate counters and status flips, redemption cumulatives plus the
 * pending-redemption marker, and batch-membership pending markers.
 * Extracted verbatim from the TroveOperation handler. */
export async function applyTroveOperationTransition(
  context: TroveOperationTransitionContext,
  args: {
    op: number;
    trove: Trove;
    instance: LiquityInstance;
    chainId: number;
    collateralId: string;
    txHash: string;
    blockTimestamp: bigint;
    blockNumber: bigint;
    collChange: bigint;
    debtChange: bigint;
    annualInterestRate: bigint;
  },
): Promise<{ trove: Trove; instance: LiquityInstance }> {
  const { op, chainId, collateralId, txHash, blockTimestamp, blockNumber } =
    args;
  let { trove, instance } = args;
  if (op === OP.OPEN_TROVE || op === OP.OPEN_TROVE_AND_JOIN_BATCH) {
    ({ trove, instance } = transitionOpenedTrove(trove, instance, {
      blockTimestamp,
      blockNumber,
      txHash,
    }));
  } else if (op === OP.CLOSE_TROVE) {
    ({ trove, instance } = transitionClosedTrove(trove, instance, {
      blockTimestamp,
      blockNumber,
      txHash,
    }));
  } else if (op === OP.LIQUIDATE) {
    ({ trove, instance } = transitionLiquidatedTrove(trove, instance, {
      collChange: args.collChange,
      debtChange: args.debtChange,
      blockTimestamp,
      blockNumber,
      txHash,
    }));
  } else if (op === OP.REDEEM_COLLATERAL) {
    trove = {
      ...trove,
      redemptionCount: trove.redemptionCount + 1,
      redeemedColl: trove.redeemedColl + negativeToPositive(args.collChange),
      redeemedDebt: trove.redeemedDebt + negativeToPositive(args.debtChange),
    };
    const collateral = await context.LiquityCollateral.get(collateralId);
    const nextStatus = statusFromCollateral(trove.debt, collateral);
    const transitioned = transitionTroveStatus(trove, nextStatus, instance);
    trove = transitioned.trove;
    instance = transitioned.instance;
    setPendingRedemption(context, {
      chainId,
      txHash,
      collateralId,
      troveId: trove.troveId,
      timestamp: blockTimestamp,
      blockNumber,
    });
  } else if (isBatchMembershipOperation(op)) {
    setPendingBatchMembershipOperation(context, {
      chainId,
      txHash,
      collateralId,
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
