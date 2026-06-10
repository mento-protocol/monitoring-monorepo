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
  protocolShareWei,
  type BorrowingFeeBucket,
  type BorrowingFeeBucketContext,
} from "./cdp-borrowing-revenue-math";

export type CdpBorrowingRevenueCollateral = {
  id: string;
  chainId: number;
  collIndex: number;
  symbol: string;
  // SP_YIELD_SPLIT in bps: the share of every interest + upfront-fee mint
  // routed to StabilityPool depositors as yield. Only the remainder is
  // protocol revenue. -1 = indexer "not loaded yet" sentinel.
  spYieldSplitBps: number;
};

export type CdpBorrowingRevenueInstance = {
  id: string;
  collateralId: string;
  chainId: number;
  systemDebt: string;
  activeTroveCount: number;
  borrowingFeeCum: string;
  // Treasury share actually minted to the yield-split Safe (cash basis).
  borrowingFeeCollectedCum: string;
  isShutDown: boolean;
  shutDownAt: string | null;
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
  collected: string;
};

// Daily series semantics: the upfront/accrued/total fields carry the
// PROTOCOL SHARE of the day's gross fees ((1 − SP_YIELD_SPLIT)-scaled), so
// the Total Fees chart sums to the page's protocol-revenue tiles.
// `collectedUSD` is the cash actually minted to the treasury Safe that day —
// a different basis, deliberately not part of `totalFeesUSD`.
export type CdpBorrowingFeeSeriesPoint = {
  timestamp: number;
  upfrontFeesUSD: number;
  accruedInterestUSD: number;
  totalFeesUSD: number;
  collectedUSD: number;
};

export type CdpBorrowingRevenueSummary = {
  // Gross fee burden borrowers pay (accrual basis): upfront + interest.
  totalRevenueUSD: number;
  upfrontFeesUSD: number;
  accruedInterestUSD: number;
  // Protocol's share of the gross: (1 − SP_YIELD_SPLIT) per market.
  protocolShareUSD: number;
  // StabilityPool depositors' yield share: gross − protocol share.
  spYieldShareUSD: number;
  // Cash basis: treasury share actually minted to the yield-split Safe.
  collectedUSD: number;
  // Protocol share earned but not yet minted (accrues until a trove touch).
  receivableUSD: number;
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
  protocolShareUSD: number;
  collectedUSD: number;
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
  instances: ReadonlyArray<CdpBorrowingRevenueInstance>;
  brackets: ReadonlyArray<CdpBorrowingRevenueBracket>;
  dailySnapshots: ReadonlyArray<CdpBorrowingRevenueDailySnapshot>;
  rates: OracleRateMap;
  nowSeconds?: number;
  window?: TimeRange;
};

function addUpfrontFeeEventsToBuckets(args: {
  feeEvents: ReadonlyArray<CdpBorrowingFeeEvent>;
  symbolByInstanceId: ReadonlyMap<string, string | undefined>;
  splitBpsByInstanceId: ReadonlyMap<string, number>;
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
      wei: protocolShareWei(
        BigInt(event.debtIncreaseFromUpfrontFee),
        args.splitBpsByInstanceId.get(event.instanceId) ?? 0,
      ),
    });
  }
}

function addBracketInterestToBuckets(args: {
  bracket: CdpBorrowingRevenueBracket;
  symbol: string | undefined;
  splitBps: number;
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
      wei: protocolShareWei(pending, args.splitBps),
    });
  }

  addLiveBracketInterestToBuckets(args);
}

function addLiveBracketInterestToBuckets(args: {
  bracket: CdpBorrowingRevenueBracket;
  symbol: string | undefined;
  splitBps: number;
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
      wei: protocolShareWei(
        liveAccruedInterestWei(args.bracket, nextCursor - cursor),
        args.splitBps,
      ),
    });
    cursor = nextCursor;
  }
}

function addDailySnapshotsToBuckets(args: {
  dailySnapshots: ReadonlyArray<CdpBorrowingRevenueDailySnapshot>;
  symbolByCollateralId: ReadonlyMap<string, string | undefined>;
  splitBpsByCollateralId: ReadonlyMap<string, number>;
  dayAlignedWindow: TimeRange | undefined;
  context: BorrowingFeeBucketContext;
}): void {
  for (const snapshot of args.dailySnapshots) {
    const timestamp = Number(snapshot.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (!isBucketInWindow(timestamp, args.dayAlignedWindow)) continue;
    const symbol = args.symbolByCollateralId.get(snapshot.collateralId);
    const splitBps =
      args.splitBpsByCollateralId.get(snapshot.collateralId) ?? 0;
    addBorrowingFeeWei(args.context, {
      symbol,
      timestamp,
      kind: "upfront",
      wei: protocolShareWei(BigInt(snapshot.upfrontFee), splitBps),
    });
    addBorrowingFeeWei(args.context, {
      symbol,
      timestamp,
      kind: "interest",
      wei: protocolShareWei(BigInt(snapshot.accruedInterest), splitBps),
    });
    // Collected is the treasury share as minted on-chain — already post-split.
    addBorrowingFeeWei(args.context, {
      symbol,
      timestamp,
      kind: "collected",
      wei: BigInt(snapshot.collected),
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
      collectedUSD: bucket?.collectedUSD ?? 0,
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

function shutDownSecondsByCollateral(
  instances: ReadonlyArray<CdpBorrowingRevenueInstance>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const instance of instances) {
    if (instance.isShutDown && instance.shutDownAt !== null) {
      map.set(instance.collateralId, Number(instance.shutDownAt));
    }
  }
  return map;
}

// A shut-down branch stops accruing borrowing interest at shutDownAt, so the
// live projection must not run past it.
function cappedProjectionSeconds(
  nowSeconds: number,
  shutDownAt: number | undefined,
): number {
  return shutDownAt !== undefined && shutDownAt < nowSeconds
    ? shutDownAt
    : nowSeconds;
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
  const splitBpsByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.spYieldSplitBps]),
  );
  const unpricedSymbols = new Set<string>();
  let upfrontFeesUSD = 0;
  let accruedInterestUSD = 0;
  let protocolShareUSD = 0;
  let collectedUSD = 0;
  let activeInterestBracketCount = 0;

  const shutDownSeconds = shutDownSecondsByCollateral(instances);

  for (const instance of instances) {
    const symbol = symbolByCollateralId.get(instance.collateralId);
    const splitBps = splitBpsByCollateralId.get(instance.collateralId) ?? 0;
    const upfrontWei = BigInt(instance.borrowingFeeCum);
    upfrontFeesUSD += addPricedWei(symbol, upfrontWei, rates, unpricedSymbols);
    protocolShareUSD += addPricedWei(
      symbol,
      protocolShareWei(upfrontWei, splitBps),
      rates,
      unpricedSymbols,
    );
    collectedUSD += addPricedWei(
      symbol,
      BigInt(instance.borrowingFeeCollectedCum),
      rates,
      unpricedSymbols,
    );
  }

  for (const bracket of brackets) {
    const symbol = symbolByCollateralId.get(bracket.collateralId);
    const splitBps = splitBpsByCollateralId.get(bracket.collateralId) ?? 0;
    const totalDebt = BigInt(bracket.totalDebt);
    const sumDebtTimesRateD36 = BigInt(bracket.sumDebtTimesRateD36);
    if (totalDebt > ZERO && sumDebtTimesRateD36 > ZERO) {
      activeInterestBracketCount += 1;
    }
    const effectiveNow = cappedProjectionSeconds(
      nowSeconds,
      shutDownSeconds.get(bracket.collateralId),
    );
    const interestWei = accruedInterestWei(bracket, effectiveNow);
    accruedInterestUSD += addPricedWei(
      symbol,
      interestWei,
      rates,
      unpricedSymbols,
    );
    protocolShareUSD += addPricedWei(
      symbol,
      protocolShareWei(interestWei, splitBps),
      rates,
      unpricedSymbols,
    );
  }

  const totalRevenueUSD = upfrontFeesUSD + accruedInterestUSD;
  return {
    totalRevenueUSD,
    upfrontFeesUSD,
    accruedInterestUSD,
    protocolShareUSD,
    spYieldShareUSD: Math.max(0, totalRevenueUSD - protocolShareUSD),
    collectedUSD,
    receivableUSD: Math.max(0, protocolShareUSD - collectedUSD),
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
      // A shut-down branch stops accruing borrowing interest, so its forward
      // annual run-rate is zero even while brackets still hold debt.
      const isCollateralShutDown = collateralInstances.some(
        (i) => i.isShutDown,
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
          isCollateralShutDown
            ? ZERO
            : annualInterestRunRateWei(collateralBrackets),
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
        protocolShareUSD: summary.protocolShareUSD,
        collectedUSD: summary.collectedUSD,
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
  const splitBpsByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.spYieldSplitBps]),
  );
  const symbolByInstanceId = new Map(
    instances.map((i) => [i.id, symbolByCollateralId.get(i.collateralId)]),
  );
  const splitBpsByInstanceId = new Map(
    instances.map((i) => [
      i.id,
      splitBpsByCollateralId.get(i.collateralId) ?? 0,
    ]),
  );
  const buckets = new Map<number, BorrowingFeeBucket>();
  const unpricedSymbols = new Set<string>();
  const dayAlignedWindow = window ? dayAlignWindow(window) : undefined;
  const context = { buckets, rates, unpricedSymbols };

  const shutDownSeconds = shutDownSecondsByCollateral(instances);

  addUpfrontFeeEventsToBuckets({
    feeEvents,
    symbolByInstanceId,
    splitBpsByInstanceId,
    dayAlignedWindow,
    context,
  });

  for (const bracket of brackets) {
    const effectiveNow = cappedProjectionSeconds(
      nowSeconds,
      shutDownSeconds.get(bracket.collateralId),
    );
    addBracketInterestToBuckets({
      bracket,
      symbol: symbolByCollateralId.get(bracket.collateralId),
      splitBps: splitBpsByCollateralId.get(bracket.collateralId) ?? 0,
      dayAlignedWindow,
      nowSeconds: effectiveNow,
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
  instances,
  brackets,
  dailySnapshots,
  rates,
  nowSeconds = Math.floor(Date.now() / 1000),
  window,
}: SnapshotSeriesAggregateArgs): CdpBorrowingFeeSeriesPoint[] {
  const symbolByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.symbol]),
  );
  const splitBpsByCollateralId = new Map(
    collaterals.map((c) => [c.id, c.spYieldSplitBps]),
  );
  const buckets = new Map<number, BorrowingFeeBucket>();
  const unpricedSymbols = new Set<string>();
  const dayAlignedWindow = window ? dayAlignWindow(window) : undefined;
  const context = { buckets, rates, unpricedSymbols };
  const shutDownSeconds = shutDownSecondsByCollateral(instances);

  addDailySnapshotsToBuckets({
    dailySnapshots,
    symbolByCollateralId,
    splitBpsByCollateralId,
    dayAlignedWindow,
    context,
  });

  for (const bracket of brackets) {
    const effectiveNow = cappedProjectionSeconds(
      nowSeconds,
      shutDownSeconds.get(bracket.collateralId),
    );
    addLiveBracketInterestToBuckets({
      bracket,
      symbol: symbolByCollateralId.get(bracket.collateralId),
      splitBps: splitBpsByCollateralId.get(bracket.collateralId) ?? 0,
      dayAlignedWindow,
      nowSeconds: effectiveNow,
      context,
    });
  }

  return buildBorrowingFeeSeriesFromBuckets(
    buckets,
    dayAlignedWindow,
    nowSeconds,
  );
}
