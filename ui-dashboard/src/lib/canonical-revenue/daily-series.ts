import { weiToUsd } from "@/lib/format";
import { buildDailyFeeSeries } from "@/lib/revenue";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { V3_REVENUE_LAUNCH_TIMESTAMP } from "./constants";
import { currentDayBucket, dayBucket } from "./utils";
import type {
  ActualRevenueAvailability,
  CanonicalRevenueDailyPoint,
  SusdsYieldDailySnapshotRow,
} from "./types";
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

function reserveSnapshotBaselineUsd(
  row: SusdsYieldDailySnapshotRow,
  totalYieldUsd: number,
): number | null {
  const dailyYieldUsd = numericUsdWei(row.dailyEarnedYieldUsdWei);
  return dailyYieldUsd === null ? null : totalYieldUsd - dailyYieldUsd;
}

export function buildRevenueBuckets(args: {
  swapSeries: ReadonlyArray<SwapDailyFeePoint>;
  cdpDailySeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>;
  reserveDailySnapshots: ReadonlyArray<SusdsYieldDailySnapshotRow>;
}): Map<number, RevenueBucket> {
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
  const reserveRows = [...args.reserveDailySnapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  for (const row of reserveRows) {
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const totalYieldUsd = numericUsdWei(row.totalEarnedYieldUsdWei);
    if (totalYieldUsd === null) continue;
    const sourceKey = `${row.chainId}:${row.token.toLowerCase()}`;
    const previousTotalUsd = previousReserveTotalsBySource.get(sourceKey);
    const baselineUsd =
      previousTotalUsd ?? reserveSnapshotBaselineUsd(row, totalYieldUsd);
    if (baselineUsd === null) continue;
    const dailyYieldUsd = totalYieldUsd - baselineUsd;
    previousReserveTotalsBySource.set(sourceKey, totalYieldUsd);
    addBucketValue(buckets, timestamp, { reserveYieldUsd: dailyYieldUsd });
  }

  return buckets;
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
