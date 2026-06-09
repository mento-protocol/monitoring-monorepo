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

// --- Read-only preload warmers --------------------------------------------
// HyperIndex runs handlers twice: a preload phase that batches DB reads, then
// an ordered processing phase. This codebase warms reads explicitly in each
// handler's `isPreload` branch. The settlement paths below read daily-snapshot
// (and bracket) rows during processing, so these helpers reissue exactly those
// reads in the preload phase to batch them. They never write; a missed warm
// degrades to a correct lazy read during processing, never to wrong data.

type BorrowingRevenueInstanceContext = BorrowingRevenueBracketContext & {
  LiquityInstance: {
    get: (id: string) => Promise<LiquityInstance | undefined>;
  };
};

// Warm the daily-snapshot rows settleInterestRateBracketRevenue reads for a
// bracket: one per day bucket in [from, until). Uses the same id constructor as
// the write path so the warmed ids are byte-identical to what processing reads.
export async function preloadBorrowingRevenueDailyBuckets(
  context: BorrowingRevenueSnapshotContext,
  instanceId: string,
  fromTimestamp: bigint,
  untilTimestamp: bigint,
): Promise<void> {
  const reads: Array<Promise<unknown>> = [];
  for (
    let bucket = dayBucket(fromTimestamp);
    bucket < untilTimestamp;
    bucket += SECONDS_PER_DAY
  ) {
    reads.push(
      context.LiquityBorrowingRevenueDailySnapshot.get(
        borrowingRevenueDailySnapshotId(instanceId, bucket),
      ),
    );
  }
  await Promise.all(reads);
}

// Warm the reads flushBorrowingRevenueDailySnapshots performs on the first
// event of a new UTC day: the per-collateral bracket set plus every bracket's
// settle range. No-op when no rollover is due (matches the processing gate).
export async function preloadBorrowingRevenueRollover(
  context: BorrowingRevenueInstanceContext,
  collateralId: string,
  untilTimestamp: bigint,
): Promise<void> {
  const instance = await context.LiquityInstance.get(collateralId);
  if (instance === undefined) return;
  if (instance.currentDayBucket >= dayBucket(untilTimestamp)) return;
  const brackets = await context.InterestRateBracket.getWhere({
    collateralId: { _eq: collateralId },
  });
  await Promise.all(
    brackets.map((bracket) =>
      preloadBorrowingRevenueDailyBuckets(
        context,
        instance.id,
        bracket.updatedAt,
        untilTimestamp,
      ),
    ),
  );
}

// Warm the daily-snapshot row recordBorrowingUpfrontFee reads when an upfront
// fee is present (the event-day bucket).
export async function preloadBorrowingUpfrontFeeBucket(
  context: BorrowingRevenueSnapshotContext,
  instanceId: string,
  fee: bigint,
  timestamp: bigint,
): Promise<void> {
  if (fee <= ZERO) return;
  await context.LiquityBorrowingRevenueDailySnapshot.get(
    borrowingRevenueDailySnapshotId(instanceId, dayBucket(timestamp)),
  );
}
