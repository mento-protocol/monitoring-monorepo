import type {
  InterestRateBracket,
  LiquityBorrowingRevenueDailySnapshot,
  LiquityInstance,
} from "envio";
import { SECONDS_PER_DAY, dayBucket } from "../../helpers.js";
import { D18, ONE_YEAR_SECONDS } from "./math.js";

const ZERO = 0n;

type BorrowingRevenueSnapshotContext = {
  LiquityBorrowingRevenueDailySnapshot: {
    get: (
      id: string,
    ) => Promise<LiquityBorrowingRevenueDailySnapshot | undefined>;
    set: (entity: LiquityBorrowingRevenueDailySnapshot) => void;
  };
};

type BorrowingRevenueBracketContext = BorrowingRevenueSnapshotContext & {
  InterestRateBracket: {
    getWhere: (args: {
      collateralId: { _eq: string };
    }) => Promise<InterestRateBracket[]>;
    set: (entity: InterestRateBracket) => void;
  };
};

export type BorrowingRevenueContext = BorrowingRevenueBracketContext;

export const borrowingRevenueDailySnapshotId = (
  instanceId: string,
  bucket: bigint,
): string => `${instanceId}-${bucket}`;

async function addBorrowingRevenueDelta(
  context: BorrowingRevenueSnapshotContext,
  args: {
    chainId: number;
    collateralId: string;
    instanceId: string;
    bucket: bigint;
    upfrontFee?: bigint;
    accruedInterest?: bigint;
    blockNumber: bigint;
    updatedAtTimestamp: bigint;
  },
): Promise<void> {
  const upfrontFee = args.upfrontFee ?? ZERO;
  const accruedInterest = args.accruedInterest ?? ZERO;
  if (upfrontFee <= ZERO && accruedInterest <= ZERO) return;

  const id = borrowingRevenueDailySnapshotId(args.instanceId, args.bucket);
  const existing = await context.LiquityBorrowingRevenueDailySnapshot.get(id);
  context.LiquityBorrowingRevenueDailySnapshot.set({
    id,
    chainId: args.chainId,
    collateralId: args.collateralId,
    instanceId: args.instanceId,
    timestamp: args.bucket,
    upfrontFee: (existing?.upfrontFee ?? ZERO) + upfrontFee,
    accruedInterest: (existing?.accruedInterest ?? ZERO) + accruedInterest,
    blockNumber: args.blockNumber,
    updatedAtTimestamp: args.updatedAtTimestamp,
  });
}

export async function recordBorrowingUpfrontFee(
  context: BorrowingRevenueSnapshotContext,
  instance: LiquityInstance,
  fee: bigint,
  timestamp: bigint,
  blockNumber: bigint,
): Promise<void> {
  await addBorrowingRevenueDelta(context, {
    chainId: instance.chainId,
    collateralId: instance.collateralId,
    instanceId: instance.id,
    bucket: dayBucket(timestamp),
    upfrontFee: fee,
    blockNumber,
    updatedAtTimestamp: timestamp,
  });
}

export async function recordBorrowingFeeAndApplyCum(
  context: BorrowingRevenueSnapshotContext,
  instance: LiquityInstance,
  fee: bigint,
  timestamp: bigint,
  blockNumber: bigint,
): Promise<LiquityInstance> {
  await recordBorrowingUpfrontFee(
    context,
    instance,
    fee,
    timestamp,
    blockNumber,
  );
  return {
    ...instance,
    borrowingFeeCum: instance.borrowingFeeCum + fee,
  };
}

export async function settleInterestRateBracketRevenue(
  context: BorrowingRevenueSnapshotContext,
  args: {
    chainId: number;
    collateralId: string;
    instanceId: string;
    bracket: InterestRateBracket;
    untilTimestamp: bigint;
    blockNumber: bigint;
  },
): Promise<InterestRateBracket> {
  const { bracket, untilTimestamp } = args;
  if (untilTimestamp <= bracket.updatedAt) return bracket;

  const elapsed = untilTimestamp - bracket.updatedAt;
  const pendingDebtTimesOneYearD36 =
    bracket.pendingDebtTimesOneYearD36 + bracket.sumDebtTimesRateD36 * elapsed;

  if (bracket.sumDebtTimesRateD36 > ZERO) {
    let cursor = bracket.updatedAt;
    while (cursor < untilTimestamp) {
      const bucket = dayBucket(cursor);
      const nextCursor =
        bucket + SECONDS_PER_DAY < untilTimestamp
          ? bucket + SECONDS_PER_DAY
          : untilTimestamp;
      const accruedInterest =
        (bracket.sumDebtTimesRateD36 * (nextCursor - cursor)) /
        ONE_YEAR_SECONDS /
        D18;
      await addBorrowingRevenueDelta(context, {
        chainId: args.chainId,
        collateralId: args.collateralId,
        instanceId: args.instanceId,
        bucket,
        accruedInterest,
        blockNumber: args.blockNumber,
        updatedAtTimestamp: untilTimestamp,
      });
      cursor = nextCursor;
    }
  }

  return {
    ...bracket,
    pendingDebtTimesOneYearD36,
    updatedAt: untilTimestamp,
  };
}

export async function flushBorrowingRevenueDailySnapshots(
  context: BorrowingRevenueBracketContext,
  instance: LiquityInstance,
  untilTimestamp: bigint,
  blockNumber: bigint,
): Promise<void> {
  const brackets = await context.InterestRateBracket.getWhere({
    collateralId: { _eq: instance.collateralId },
  });

  for (const bracket of brackets) {
    const next = await settleInterestRateBracketRevenue(context, {
      chainId: instance.chainId,
      collateralId: instance.collateralId,
      instanceId: instance.id,
      bracket,
      untilTimestamp,
      blockNumber,
    });
    if (next !== bracket) context.InterestRateBracket.set(next);
  }
}
