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

function isZeroWei(value: string): boolean {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return false;
  try {
    return BigInt(trimmed) === BigInt(0);
  } catch {
    return false;
  }
}

function isZeroExposureStethSnapshot(row: StethYieldDailySnapshotRow): boolean {
  return [
    row.balanceAmount,
    row.principalAmount,
    row.totalEarnedYieldAmount,
    row.dailyEarnedYieldAmount,
  ].every(isZeroWei);
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
  return stethAmountUsd(row.totalEarnedYieldAmount, usdPerToken);
}

function reserveSnapshotBaselineUsd(
  row: SusdsYieldDailySnapshotRow,
  totalYieldUsd: number,
): number | null {
  const dailyYieldUsd = numericUsdWei(row.dailyEarnedYieldUsdWei);
  return dailyYieldUsd === null ? null : totalYieldUsd - dailyYieldUsd;
}

function stethAmountUsd(
  value: string,
  usdPerToken: number | undefined,
): number | null {
  if (usdPerToken === undefined) return null;
  const amount = numericTokenWei(value);
  if (amount === null) return null;
  const usd = amount * usdPerToken;
  return Number.isFinite(usd) ? usd : null;
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
  const dailyYieldUsd = stethAmountUsd(row.dailyEarnedYieldAmount, usdPerToken);
  return dailyYieldUsd === null ? null : totalYieldUsd - dailyYieldUsd;
}

function addReserveSnapshotRow(
  row: ReserveYieldDailySnapshotRow,
  stethRates: ReadonlyMap<string, number>,
  previousTotalsBySource: Map<string, number>,
  buckets: Map<number, RevenueBucket>,
): boolean {
  const timestamp = Number(row.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  const sourceKey = reserveSnapshotSourceKey(row);
  if (isStethSnapshot(row) && isZeroExposureStethSnapshot(row)) {
    const previousTotalUsd = previousTotalsBySource.get(sourceKey);
    addBucketValue(buckets, timestamp, {
      reserveYieldUsd: previousTotalUsd === undefined ? 0 : -previousTotalUsd,
    });
    previousTotalsBySource.set(sourceKey, 0);
    return false;
  }
  const totalYieldUsd = reserveSnapshotTotalUsd(row, stethRates);
  if (totalYieldUsd === null) return isStethSnapshot(row);
  const previousTotalUsd = previousTotalsBySource.get(sourceKey);
  const baselineUsd =
    previousTotalUsd ?? reserveSnapshotBaseline(row, totalYieldUsd, stethRates);
  if (baselineUsd === null) return isStethSnapshot(row);
  const dailyYieldUsd = totalYieldUsd - baselineUsd;
  previousTotalsBySource.set(sourceKey, totalYieldUsd);
  addBucketValue(buckets, timestamp, { reserveYieldUsd: dailyYieldUsd });
  return false;
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
    const rowUnpriced = addReserveSnapshotRow(
      row,
      stethRates,
      previousReserveTotalsBySource,
      buckets,
    );
    reserveHistoryUnpriced = rowUnpriced || reserveHistoryUnpriced;
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
