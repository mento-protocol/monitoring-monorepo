import { type OracleRateMap } from "./tokens";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import type { TimeRange } from "./volume";
import {
  ZERO,
  D18,
  accruedInterestWei,
  pendingAccruedInterestWei,
  liveAccruedInterestWei,
  dayBucket,
  dayAlignWindow,
  addPricedWei,
  addBorrowingFeeWei,
  bucketHasValue,
  isBucketInWindow,
  type BorrowingFeeBucket,
  type BorrowingFeeBucketContext,
} from "./cdp-borrowing-revenue-math";

export type CdpBorrowingRevenueCollateral = {
  id: string;
  chainId: number;
  collIndex: number;
  symbol: string;
};

export type CdpBorrowingRevenueInstance = {
  id: string;
  collateralId: string;
  chainId: number;
  systemDebt: string;
  activeTroveCount: number;
  borrowingFeeCum: string;
};

export type CdpBorrowingRevenueBracket = {
  id: string;
  collateralId: string;
  rate: string;
  totalDebt: string;
  sumDebtTimesRateD36: string;
  pendingDebtTimesOneYearD36: string;
  updatedAt: string;
};

export type CdpBorrowingFeeEvent = {
  id: string;
  instanceId: string;
  debtIncreaseFromUpfrontFee: string;
  timestamp: string;
};

export type CdpBorrowingRevenueDailySnapshot = {
  id: string;
  chainId: number;
  collateralId: string;
  instanceId: string;
  timestamp: string;
  upfrontFee: string;
  accruedInterest: string;
};

export type CdpBorrowingFeeSeriesPoint = {
  timestamp: number;
  upfrontFeesUSD: number;
  accruedInterestUSD: number;
  totalFeesUSD: number;
};

export type CdpBorrowingRevenueSummary = {
  totalRevenueUSD: number;
  upfrontFeesUSD: number;
  accruedInterestUSD: number;
  marketCount: number;
  activeInterestBracketCount: number;
  unpricedSymbols: string[];
  bracketsTruncated: boolean;
};

export type CdpBorrowingRevenueMarket = {
  collateralId: string;
  chainId: number;
  collIndex: number;
  symbol: string;
  activeDebtUSD: number;
  averageAnnualInterestRatePercent: number | null;
  annualInterestRunRateUSD: number;
  activeTroveCount: number;
  totalRevenueUSD: number;
  upfrontFeesUSD: number;
  accruedInterestUSD: number;
  activeInterestBracketCount: number;
  unpricedSymbols: string[];
  bracketsTruncated: boolean;
};

type AggregateArgs = {
  collaterals: ReadonlyArray<CdpBorrowingRevenueCollateral>;
  instances: ReadonlyArray<CdpBorrowingRevenueInstance>;
  brackets: ReadonlyArray<CdpBorrowingRevenueBracket>;
  rates: OracleRateMap;
  nowSeconds?: number;
  bracketsTruncated?: boolean;
};

type SeriesAggregateArgs = {
  collaterals: ReadonlyArray<CdpBorrowingRevenueCollateral>;
  instances: ReadonlyArray<CdpBorrowingRevenueInstance>;
  brackets: ReadonlyArray<CdpBorrowingRevenueBracket>;
  feeEvents: ReadonlyArray<CdpBorrowingFeeEvent>;
  rates: OracleRateMap;
  nowSeconds?: number;
  window?: TimeRange;
};

type SnapshotSeriesAggregateArgs = {
  collaterals: ReadonlyArray<CdpBorrowingRevenueCollateral>;
  brackets: ReadonlyArray<CdpBorrowingRevenueBracket>;
  dailySnapshots: ReadonlyArray<CdpBorrowingRevenueDailySnapshot>;
  rates: OracleRateMap;
  nowSeconds?: number;
  window?: TimeRange;
};

function addUpfrontFeeEventsToBuckets(args: {
  feeEvents: ReadonlyArray<CdpBorrowingFeeEvent>;
  symbolByInstanceId: ReadonlyMap<string, string | undefined>;
  dayAlignedWindow: TimeRange | undefined;
  context: BorrowingFeeBucketContext;
}): void {
  for (const event of args.feeEvents) {
    const timestamp = Number(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (!isBucketInWindow(timestamp, args.dayAlignedWindow)) continue;
    addBorrowingFeeWei(args.context, {
      symbol: args.symbolByInstanceId.get(event.instanceId),
      timestamp,
      kind: "upfront",
      wei: BigInt(event.debtIncreaseFromUpfrontFee),
    });
  }
}

function addBracketInterestToBuckets(args: {
  bracket: CdpBorrowingRevenueBracket;
  symbol: string | undefined;
  dayAlignedWindow: TimeRange | undefined;
  nowSeconds: number;
  context: BorrowingFeeBucketContext;
}): void {
  const updatedAt = Number(args.bracket.updatedAt);
  if (!Number.isFinite(updatedAt)) return;

  const pending = pendingAccruedInterestWei(args.bracket);
  if (pending > ZERO && isBucketInWindow(updatedAt, args.dayAlignedWindow)) {
    addBorrowingFeeWei(args.context, {
      symbol: args.symbol,
      timestamp: updatedAt,
      kind: "interest",
      wei: pending,
    });
  }

  const liveFrom = Math.max(
    Math.floor(updatedAt),
    args.dayAlignedWindow?.from ?? 0,
  );
  const liveTo = Math.min(
    Math.max(0, Math.floor(args.nowSeconds)),
    args.dayAlignedWindow?.to ?? Math.max(0, Math.floor(args.nowSeconds)),
  );
  let cursor = liveFrom;
  while (cursor < liveTo) {
    const bucketTimestamp = dayBucket(cursor);
    const nextCursor = Math.min(liveTo, bucketTimestamp + SECONDS_PER_DAY);
    addBorrowingFeeWei(args.context, {
      symbol: args.symbol,
      timestamp: cursor,
      kind: "interest",
      wei: liveAccruedInterestWei(args.bracket, nextCursor - cursor),
    });
    cursor = nextCursor;
  }
}

function addLiveBracketInterestToBuckets(args: {
  bracket: CdpBorrowingRevenueBracket;
  symbol: string | undefined;
  dayAlignedWindow: TimeRange | undefined;
  nowSeconds: number;
  context: BorrowingFeeBucketContext;
}): void {
  const updatedAt = Number(args.bracket.updatedAt);
  if (!Number.isFinite(updatedAt)) return;

  const liveFrom = Math.max(
    Math.floor(updatedAt),
    args.dayAlignedWindow?.from ?? 0,
  );
  const liveTo = Math.min(
    Math.max(0, Math.floor(args.nowSeconds)),
    args.dayAlignedWindow?.to ?? Math.max(0, Math.floor(args.nowSeconds)),
  );
  let cursor = liveFrom;
  while (cursor < liveTo) {
    const bucketTimestamp = dayBucket(cursor);
    const nextCursor = Math.min(liveTo, bucketTimestamp + SECONDS_PER_DAY);
    addBorrowingFeeWei(args.context, {
      symbol: args.symbol,
      timestamp: cursor,
      kind: "interest",
      wei: liveAccruedInterestWei(args.bracket, nextCursor - cursor),
    });
    cursor = nextCursor;
  }
}

function addDailySnapshotsToBuckets(args: {
  dailySnapshots: ReadonlyArray<CdpBorrowingRevenueDailySnapshot>;
  symbolByCollateralId: ReadonlyMap<string, string | undefined>;
  dayAlignedWindow: TimeRange | undefined;
  context: BorrowingFeeBucketContext;
}): void {
  for (const snapshot of args.dailySnapshots) {
    const timestamp = Number(snapshot.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (!isBucketInWindow(timestamp, args.dayAlignedWindow)) continue;
    const symbol = args.symbolByCollateralId.get(snapshot.collateralId);
    addBorrowingFeeWei(args.context, {
      symbol,
      timestamp,
      kind: "upfront",
      wei: BigInt(snapshot.upfrontFee),
    });
    addBorrowingFeeWei(args.context, {
      symbol,
      timestamp,
      kind: "interest",
      wei: BigInt(snapshot.accruedInterest),
    });
  }
}

function buildBorrowingFeeSeriesFromBuckets(
  buckets: ReadonlyMap<number, BorrowingFeeBucket>,
  dayAlignedWindow: TimeRange | undefined,
  nowSeconds: number,
): CdpBorrowingFeeSeriesPoint[] {
  const valuedBuckets = [...buckets.keys()].filter((timestamp) =>
    bucketHasValue(buckets.get(timestamp)),
  );
  if (valuedBuckets.length === 0) return [];

  const startBucket = dayAlignedWindow
    ? dayAlignedWindow.from
    : Math.min(...valuedBuckets);
  const endRef = dayAlignedWindow?.to ?? Math.max(0, Math.floor(nowSeconds));
  const endBucket = dayBucket(endRef);
  const lastBucket =
    endRef > endBucket ? endBucket : endBucket - SECONDS_PER_DAY;
  if (lastBucket < startBucket) return [];

  const series: CdpBorrowingFeeSeriesPoint[] = [];
  for (
    let timestamp = startBucket;
    timestamp <= lastBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    const bucket = buckets.get(timestamp);
    const upfrontFeesUSD = bucket?.upfrontFeesUSD ?? 0;
    const accruedInterestUSD = bucket?.accruedInterestUSD ?? 0;
    series.push({
      timestamp,
      upfrontFeesUSD,
      accruedInterestUSD,
      totalFeesUSD: upfrontFeesUSD + accruedInterestUSD,
    });
  }
  return series;
}

function activeDebtWei(
  instances: ReadonlyArray<CdpBorrowingRevenueInstance>,
): bigint {
  return instances.reduce(
    (total, instance) => total + BigInt(instance.systemDebt),
    ZERO,
  );
}

function annualInterestRunRateWei(
  brackets: ReadonlyArray<CdpBorrowingRevenueBracket>,
): bigint {
  return brackets.reduce(
    (total, bracket) => total + BigInt(bracket.sumDebtTimesRateD36) / D18,
    ZERO,
  );
}

function weightedAnnualInterestRatePercent(
  brackets: ReadonlyArray<CdpBorrowingRevenueBracket>,
): number | null {
  const { totalDebt, sumDebtTimesRateD36 } = brackets.reduce(
    (acc, bracket) => {
      const totalDebt = BigInt(bracket.totalDebt);
      if (totalDebt <= ZERO) return acc;
      return {
        totalDebt: acc.totalDebt + totalDebt,
        sumDebtTimesRateD36:
          acc.sumDebtTimesRateD36 + BigInt(bracket.sumDebtTimesRateD36),
      };
    },
    { totalDebt: ZERO, sumDebtTimesRateD36: ZERO },
  );

  if (totalDebt <= ZERO) return null;
  const weightedRateD18 = sumDebtTimesRateD36 / totalDebt;
  return Number(weightedRateD18) / 1e16;
}

export function aggregateCdpBorrowingRevenue({
  collaterals,
  instances,
  brackets,
  rates,
  nowSeconds = Math.floor(Date.now() / 1000),
  bracketsTruncated = false,
}: AggregateArgs): CdpBorrowingRevenueSummary {
  const symbolByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.symbol]),
  );
  const unpricedSymbols = new Set<string>();
  let upfrontFeesUSD = 0;
  let accruedInterestUSD = 0;
  let activeInterestBracketCount = 0;

  for (const instance of instances) {
    upfrontFeesUSD += addPricedWei(
      symbolByCollateralId.get(instance.collateralId),
      BigInt(instance.borrowingFeeCum),
      rates,
      unpricedSymbols,
    );
  }

  for (const bracket of brackets) {
    const symbol = symbolByCollateralId.get(bracket.collateralId);
    const totalDebt = BigInt(bracket.totalDebt);
    const sumDebtTimesRateD36 = BigInt(bracket.sumDebtTimesRateD36);
    if (totalDebt > ZERO && sumDebtTimesRateD36 > ZERO) {
      activeInterestBracketCount += 1;
    }
    accruedInterestUSD += addPricedWei(
      symbol,
      accruedInterestWei(bracket, nowSeconds),
      rates,
      unpricedSymbols,
    );
  }

  return {
    totalRevenueUSD: upfrontFeesUSD + accruedInterestUSD,
    upfrontFeesUSD,
    accruedInterestUSD,
    marketCount: collaterals.length,
    activeInterestBracketCount,
    unpricedSymbols: [...unpricedSymbols].sort(),
    bracketsTruncated,
  };
}

export function aggregateCdpBorrowingRevenueMarkets({
  collaterals,
  instances,
  brackets,
  rates,
  nowSeconds = Math.floor(Date.now() / 1000),
  bracketsTruncated = false,
}: AggregateArgs): CdpBorrowingRevenueMarket[] {
  return collaterals
    .map((collateral) => {
      const collateralInstances = instances.filter(
        (i) => i.collateralId === collateral.id,
      );
      const collateralBrackets = brackets.filter(
        (b) => b.collateralId === collateral.id,
      );
      const summary = aggregateCdpBorrowingRevenue({
        collaterals: [collateral],
        instances: collateralInstances,
        brackets: collateralBrackets,
        rates,
        nowSeconds,
        bracketsTruncated,
      });
      const unpricedSymbols = new Set(summary.unpricedSymbols);
      return {
        collateralId: collateral.id,
        chainId: collateral.chainId,
        collIndex: collateral.collIndex,
        symbol: collateral.symbol,
        activeDebtUSD: addPricedWei(
          collateral.symbol,
          activeDebtWei(collateralInstances),
          rates,
          unpricedSymbols,
        ),
        averageAnnualInterestRatePercent:
          weightedAnnualInterestRatePercent(collateralBrackets),
        annualInterestRunRateUSD: addPricedWei(
          collateral.symbol,
          annualInterestRunRateWei(collateralBrackets),
          rates,
          unpricedSymbols,
        ),
        activeTroveCount: collateralInstances.reduce(
          (total, instance) => total + instance.activeTroveCount,
          0,
        ),
        totalRevenueUSD: summary.totalRevenueUSD,
        upfrontFeesUSD: summary.upfrontFeesUSD,
        accruedInterestUSD: summary.accruedInterestUSD,
        activeInterestBracketCount: summary.activeInterestBracketCount,
        unpricedSymbols: [...unpricedSymbols].sort(),
        bracketsTruncated: summary.bracketsTruncated,
      };
    })
    .sort(
      (a, b) =>
        b.totalRevenueUSD - a.totalRevenueUSD || a.collIndex - b.collIndex,
    );
}

export function buildDailyCdpBorrowingFeeSeries({
  collaterals,
  instances,
  brackets,
  feeEvents,
  rates,
  nowSeconds = Math.floor(Date.now() / 1000),
  window,
}: SeriesAggregateArgs): CdpBorrowingFeeSeriesPoint[] {
  const symbolByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.symbol]),
  );
  const symbolByInstanceId = new Map(
    instances.map((i) => [i.id, symbolByCollateralId.get(i.collateralId)]),
  );
  const buckets = new Map<number, BorrowingFeeBucket>();
  const unpricedSymbols = new Set<string>();
  const dayAlignedWindow = window ? dayAlignWindow(window) : undefined;
  const context = { buckets, rates, unpricedSymbols };

  addUpfrontFeeEventsToBuckets({
    feeEvents,
    symbolByInstanceId,
    dayAlignedWindow,
    context,
  });

  for (const bracket of brackets) {
    addBracketInterestToBuckets({
      bracket,
      symbol: symbolByCollateralId.get(bracket.collateralId),
      dayAlignedWindow,
      nowSeconds,
      context,
    });
  }
  return buildBorrowingFeeSeriesFromBuckets(
    buckets,
    dayAlignedWindow,
    nowSeconds,
  );
}

export function buildDailyCdpBorrowingFeeSeriesFromSnapshots({
  collaterals,
  brackets,
  dailySnapshots,
  rates,
  nowSeconds = Math.floor(Date.now() / 1000),
  window,
}: SnapshotSeriesAggregateArgs): CdpBorrowingFeeSeriesPoint[] {
  const symbolByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.symbol]),
  );
  const buckets = new Map<number, BorrowingFeeBucket>();
  const unpricedSymbols = new Set<string>();
  const dayAlignedWindow = window ? dayAlignWindow(window) : undefined;
  const context = { buckets, rates, unpricedSymbols };

  addDailySnapshotsToBuckets({
    dailySnapshots,
    symbolByCollateralId,
    dayAlignedWindow,
    context,
  });

  for (const bracket of brackets) {
    addLiveBracketInterestToBuckets({
      bracket,
      symbol: symbolByCollateralId.get(bracket.collateralId),
      dayAlignedWindow,
      nowSeconds,
      context,
    });
  }

  return buildBorrowingFeeSeriesFromBuckets(
    buckets,
    dayAlignedWindow,
    nowSeconds,
  );
}
