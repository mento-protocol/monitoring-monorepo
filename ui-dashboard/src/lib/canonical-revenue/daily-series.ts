import { weiToUsd } from "@/lib/format";
import { buildDailyFeeSeries } from "@/lib/revenue";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { V3_REVENUE_LAUNCH_TIMESTAMP } from "./constants";
import { currentDayBucket, dayBucket } from "./utils";
import type {
  ActualRevenueAvailability,
  CanonicalRevenueDailyPoint,
  ReserveYieldDailySnapshotRow,
  StethYieldDailySnapshotRow,
  SusdsYieldDailySnapshotRow,
} from "./types";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import type { CdpBorrowingFeeSeriesPoint } from "@/lib/cdp-borrowing-revenue";

type SwapDailyFeePoint = ReturnType<typeof buildDailyFeeSeries>[number];

type RevenueBucket = {
  reserveYieldUsd: number;
  swapFeesUsd: number;
  cdpBorrowingUsd: number;
};

function emptyRevenueBucket(): RevenueBucket {
  return { reserveYieldUsd: 0, swapFeesUsd: 0, cdpBorrowingUsd: 0 };
}

function addBucketValue(
  buckets: Map<number, RevenueBucket>,
  timestamp: number,
  value: Partial<RevenueBucket>,
): void {
  if (timestamp < V3_REVENUE_LAUNCH_TIMESTAMP) return;
  const bucketKey = dayBucket(timestamp);
  const bucket = buckets.get(bucketKey) ?? emptyRevenueBucket();
  bucket.reserveYieldUsd += value.reserveYieldUsd ?? 0;
  bucket.swapFeesUsd += value.swapFeesUsd ?? 0;
  bucket.cdpBorrowingUsd += value.cdpBorrowingUsd ?? 0;
  buckets.set(bucketKey, bucket);
}

function numericUsdWei(value: string): number | null {
  try {
    const usd = weiToUsd(BigInt(value));
    return Number.isFinite(usd) ? usd : null;
  } catch {
    return null;
  }
}

function numericTokenWei(value: string): number | null {
  try {
    const tokenAmount = weiToUsd(BigInt(value));
    return Number.isFinite(tokenAmount) ? tokenAmount : null;
  } catch {
    return null;
  }
}

function isStethSnapshot(
  row: ReserveYieldDailySnapshotRow,
): row is StethYieldDailySnapshotRow {
  return "wallet" in row;
}

function stethUsdPerTokenByWallet(
  reserveYield: ReserveYieldResponse | null,
): Map<string, number> {
  const rates = new Map<string, number>();
  if (reserveYield === null) return rates;
  for (const holding of reserveYield.holdings) {
    if (
      holding.assetSymbol.toUpperCase() !== "STETH" ||
      holding.identifier === null ||
      !holding.hasTokenBalance ||
      holding.balance <= 0
    ) {
      continue;
    }
    const usdPerToken = holding.principalUsd / holding.balance;
    if (Number.isFinite(usdPerToken) && usdPerToken > 0) {
      rates.set(holding.identifier.toLowerCase(), usdPerToken);
    }
  }
  return rates;
}

function reserveSnapshotSourceKey(row: ReserveYieldDailySnapshotRow): string {
  const tokenKey = `${row.chainId}:${row.token.toLowerCase()}`;
  return isStethSnapshot(row)
    ? `${tokenKey}:${row.wallet.toLowerCase()}`
    : tokenKey;
}

function reserveSnapshotTotalUsd(
  row: ReserveYieldDailySnapshotRow,
  stethRates: ReadonlyMap<string, number>,
): number | null {
  if (!isStethSnapshot(row)) return numericUsdWei(row.totalEarnedYieldUsdWei);
  const usdPerToken = stethRates.get(row.wallet.toLowerCase());
  const earnedAmount = numericTokenWei(row.totalEarnedYieldAmount);
  return usdPerToken === undefined || earnedAmount === null
    ? null
    : earnedAmount * usdPerToken;
}

function reserveSnapshotBaselineUsd(
  row: SusdsYieldDailySnapshotRow,
  totalYieldUsd: number,
): number | null {
  const dailyYieldUsd = numericUsdWei(row.dailyEarnedYieldUsdWei);
  return dailyYieldUsd === null ? null : totalYieldUsd - dailyYieldUsd;
}

function stethSnapshotBaselineUsd(
  row: StethYieldDailySnapshotRow,
  totalYieldUsd: number,
  usdPerToken: number,
): number | null {
  const dailyYieldAmount = numericTokenWei(row.dailyEarnedYieldAmount);
  return dailyYieldAmount === null
    ? null
    : totalYieldUsd - dailyYieldAmount * usdPerToken;
}

function reserveSnapshotBaseline(
  row: ReserveYieldDailySnapshotRow,
  totalYieldUsd: number,
  stethRates: ReadonlyMap<string, number>,
): number | null {
  if (!isStethSnapshot(row)) {
    return reserveSnapshotBaselineUsd(row, totalYieldUsd);
  }
  const usdPerToken = stethRates.get(row.wallet.toLowerCase());
  return usdPerToken === undefined
    ? null
    : stethSnapshotBaselineUsd(row, totalYieldUsd, usdPerToken);
}

export function buildRevenueBuckets(args: {
  swapSeries: ReadonlyArray<SwapDailyFeePoint>;
  cdpDailySeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>;
  reserveDailySnapshots: ReadonlyArray<ReserveYieldDailySnapshotRow>;
  reserveYield: ReserveYieldResponse | null;
}): {
  buckets: Map<number, RevenueBucket>;
  reserveHistoryUnpriced: boolean;
} {
  const buckets = new Map<number, RevenueBucket>();

  for (const point of args.swapSeries) {
    addBucketValue(buckets, point.timestamp, {
      swapFeesUsd: point.protocolFeesUSD + point.lpFeesUSD,
    });
  }

  for (const point of args.cdpDailySeries) {
    addBucketValue(buckets, point.timestamp, {
      cdpBorrowingUsd: point.totalFeesUSD,
    });
  }

  const previousReserveTotalsBySource = new Map<string, number>();
  const stethRates = stethUsdPerTokenByWallet(args.reserveYield);
  let reserveHistoryUnpriced = false;
  const reserveRows = [...args.reserveDailySnapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  for (const row of reserveRows) {
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const totalYieldUsd = reserveSnapshotTotalUsd(row, stethRates);
    if (totalYieldUsd === null) {
      if (isStethSnapshot(row)) reserveHistoryUnpriced = true;
      continue;
    }
    const sourceKey = reserveSnapshotSourceKey(row);
    const previousTotalUsd = previousReserveTotalsBySource.get(sourceKey);
    const baselineUsd =
      previousTotalUsd ??
      reserveSnapshotBaseline(row, totalYieldUsd, stethRates);
    if (baselineUsd === null) {
      if (isStethSnapshot(row)) reserveHistoryUnpriced = true;
      continue;
    }
    const dailyYieldUsd = totalYieldUsd - baselineUsd;
    previousReserveTotalsBySource.set(sourceKey, totalYieldUsd);
    addBucketValue(buckets, timestamp, { reserveYieldUsd: dailyYieldUsd });
  }

  return { buckets, reserveHistoryUnpriced };
}

export function buildDailySeries(
  buckets: ReadonlyMap<number, RevenueBucket>,
  nowSeconds: number,
  actualAvailability: ActualRevenueAvailability,
): CanonicalRevenueDailyPoint[] {
  const today = currentDayBucket(nowSeconds);
  const endBucket = today;
  const series: CanonicalRevenueDailyPoint[] = [];
  for (
    let timestamp = V3_REVENUE_LAUNCH_TIMESTAMP;
    timestamp <= endBucket;
    timestamp += SECONDS_PER_DAY
  ) {
    const bucket = buckets.get(timestamp) ?? emptyRevenueBucket();
    const reserveStale =
      actualAvailability.reserveStaleAfter !== null &&
      timestamp > actualAvailability.reserveStaleAfter;
    const reserveYieldUsd =
      actualAvailability.reserve && !reserveStale
        ? bucket.reserveYieldUsd
        : null;
    const swapFeesUsd = actualAvailability.swap ? bucket.swapFeesUsd : null;
    const cdpBorrowingUsd = actualAvailability.cdp
      ? bucket.cdpBorrowingUsd
      : null;
    const values = [reserveYieldUsd, swapFeesUsd, cdpBorrowingUsd];
    const availableRevenueUsd = values.reduce<number>(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    const totalRevenueUsd =
      reserveYieldUsd === null ||
      swapFeesUsd === null ||
      cdpBorrowingUsd === null
        ? null
        : availableRevenueUsd;
    series.push({
      timestamp,
      reserveYieldUsd,
      swapFeesUsd,
      cdpBorrowingUsd,
      totalRevenueUsd,
      availableRevenueUsd,
    });
  }
  return series;
}
