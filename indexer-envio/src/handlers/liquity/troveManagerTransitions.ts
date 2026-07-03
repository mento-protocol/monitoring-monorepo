import type { LiquityInstance, Trove } from "envio";
import { negativeToPositive } from "./math.js";
import { OP } from "./operations.js";
import { TROVE_STATUS, transitionTroveStatus } from "./troves.js";

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
