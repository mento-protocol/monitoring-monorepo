import { weiToUsd } from "@/lib/format";
import { buildDailyFeeSeries } from "@/lib/revenue";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
} from "@/lib/cdp-borrowing-revenue";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import type { NetworkData } from "@/lib/fetch-all-networks";

export const V3_REVENUE_LAUNCH_TIMESTAMP = 1_772_496_000;
export const V3_REVENUE_LAUNCH_LABEL = "Mar 3, 2026";

export type SusdsYieldDailySnapshotRow = {
  id: string;
  chainId: number;
  token: string;
  timestamp: string;
  currentShares: string;
  costBasisUsdWei: string;
  realizedYieldUsdWei: string;
  transferredOutYieldUsdWei: string;
  redeemedYieldUsdWei: string;
  currentValueUsdWei: string;
  unrealizedYieldUsdWei: string;
  totalEarnedYieldUsdWei: string;
  dailyEarnedYieldUsdWei: string;
  dailyRealizedYieldUsdWei: string;
  dailyUnrealizedYieldUsdWei: string;
  sharePriceUsdWei: string;
  sampledAtBlock: string;
  sampledAtTimestamp: string;
};

export type CanonicalRevenueDailyPoint = {
  timestamp: number;
  reserveYieldUsd: number;
  swapFeesUsd: number;
  cdpBorrowingUsd: number;
  totalRevenueUsd: number;
};

export type RevenuePeriodKey = "allTimeSinceV3" | "ytd" | "last30d" | "last7d";

export type RevenueForecastKey = "next7d" | "next30d" | "next365d";

export type CanonicalRevenuePeriod = {
  key: RevenuePeriodKey;
  title: string;
  subtitle: string;
  from: number;
  to: number;
  totalUsd: number;
  reserveYieldUsd: number;
  swapFeesUsd: number;
  cdpBorrowingUsd: number;
  partialReasons: string[];
};

export type CanonicalRevenueForecast = {
  key: RevenueForecastKey;
  title: string;
  subtitle: string;
  days: number;
  totalUsd: number | null;
  reserveYieldUsd: number | null;
  swapFeesUsd: number | null;
  cdpBorrowingUsd: number | null;
  partialReasons: string[];
  assumption: string;
};

export type CanonicalRevenueStream = {
  key: "reserve" | "swap" | "cdp";
  title: string;
  actualUsd: number;
  forecast30dUsd: number | null;
  forecast365dUsd: number | null;
  subtitle: string;
  partialReasons: string[];
};

export type CanonicalRevenueResult = {
  periods: Record<RevenuePeriodKey, CanonicalRevenuePeriod>;
  forecasts: Record<RevenueForecastKey, CanonicalRevenueForecast>;
  dailySeries: CanonicalRevenueDailyPoint[];
  streams: Record<CanonicalRevenueStream["key"], CanonicalRevenueStream>;
  partialReasons: string[];
};

export type BuildCanonicalRevenueArgs = {
  networkData: ReadonlyArray<NetworkData>;
  cdpDailySeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>;
  cdpMarkets: ReadonlyArray<CdpBorrowingRevenueMarket>;
  reserveYield: ReserveYieldResponse | null;
  reserveDailySnapshots: ReadonlyArray<SusdsYieldDailySnapshotRow>;
  reserveHistoryUnavailable?: boolean;
  reserveHistoryFailed?: boolean;
  reserveHistoryTruncated?: boolean;
  swapFeesFailed?: boolean;
  swapFeesApproximate?: boolean;
  cdpDailySeriesFailed?: boolean;
  nowSeconds?: number;
};

type RevenueBucket = {
  reserveYieldUsd: number;
  swapFeesUsd: number;
  cdpBorrowingUsd: number;
};

type ForecastSource = {
  reserveDailyUsd: number | null;
  reserve30dUsd: number | null;
  reserve365dUsd: number | null;
  swapDailyUsd: number | null;
  cdpDailyUsd: number | null;
  partialReasons: string[];
};

function currentDayBucket(nowSeconds: number): number {
  return dayBucket(Math.floor(nowSeconds));
}

function dayBucket(timestampSeconds: number): number {
  return Math.floor(timestampSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function isoDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

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
  if (bucketKey < V3_REVENUE_LAUNCH_TIMESTAMP) return;
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

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildRevenueBuckets(args: {
  swapSeries: ReadonlyArray<ReturnType<typeof buildDailyFeeSeries>[number]>;
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

  for (const row of args.reserveDailySnapshots) {
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const dailyYieldUsd = numericUsdWei(row.dailyEarnedYieldUsdWei);
    if (dailyYieldUsd === null) continue;
    addBucketValue(buckets, timestamp, { reserveYieldUsd: dailyYieldUsd });
  }

  return buckets;
}

function buildDailySeries(
  buckets: ReadonlyMap<number, RevenueBucket>,
  nowSeconds: number,
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
    series.push({
      timestamp,
      reserveYieldUsd: bucket.reserveYieldUsd,
      swapFeesUsd: bucket.swapFeesUsd,
      cdpBorrowingUsd: bucket.cdpBorrowingUsd,
      totalRevenueUsd:
        bucket.reserveYieldUsd + bucket.swapFeesUsd + bucket.cdpBorrowingUsd,
    });
  }
  return series;
}

function yearStartBucket(nowSeconds: number): number {
  const now = new Date(nowSeconds * 1000);
  return Math.floor(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0) / 1000);
}

function periodWindows(
  nowSeconds: number,
): Record<
  RevenuePeriodKey,
  Pick<CanonicalRevenuePeriod, "key" | "title" | "subtitle" | "from" | "to">
> {
  const today = currentDayBucket(nowSeconds);
  const tomorrow = today + SECONDS_PER_DAY;
  const ytdStart = Math.max(
    yearStartBucket(nowSeconds),
    V3_REVENUE_LAUNCH_TIMESTAMP,
  );
  return {
    allTimeSinceV3: {
      key: "allTimeSinceV3",
      title: "Total Revenue",
      subtitle: `Since ${V3_REVENUE_LAUNCH_LABEL}`,
      from: V3_REVENUE_LAUNCH_TIMESTAMP,
      to: tomorrow,
    },
    ytd: {
      key: "ytd",
      title: "Year To Date",
      subtitle: `Calendar YTD since ${isoDate(ytdStart)}`,
      from: ytdStart,
      to: tomorrow,
    },
    last30d: {
      key: "last30d",
      title: "Last 30 Days",
      subtitle: "Rolling UTC daily buckets",
      from: today - 29 * SECONDS_PER_DAY,
      to: tomorrow,
    },
    last7d: {
      key: "last7d",
      title: "Last 7 Days",
      subtitle: "Rolling UTC daily buckets",
      from: today - 6 * SECONDS_PER_DAY,
      to: tomorrow,
    },
  };
}

function sumDailySeriesWindow(
  series: ReadonlyArray<CanonicalRevenueDailyPoint>,
  from: number,
  to: number,
): Pick<
  CanonicalRevenuePeriod,
  "totalUsd" | "reserveYieldUsd" | "swapFeesUsd" | "cdpBorrowingUsd"
> {
  let reserveYieldUsd = 0;
  let swapFeesUsd = 0;
  let cdpBorrowingUsd = 0;
  for (const point of series) {
    if (point.timestamp < from || point.timestamp >= to) continue;
    reserveYieldUsd += point.reserveYieldUsd;
    swapFeesUsd += point.swapFeesUsd;
    cdpBorrowingUsd += point.cdpBorrowingUsd;
  }
  return {
    reserveYieldUsd,
    swapFeesUsd,
    cdpBorrowingUsd,
    totalUsd: reserveYieldUsd + swapFeesUsd + cdpBorrowingUsd,
  };
}

function buildPeriods(
  series: ReadonlyArray<CanonicalRevenueDailyPoint>,
  nowSeconds: number,
  partialReasons: string[],
): Record<RevenuePeriodKey, CanonicalRevenuePeriod> {
  const windows = periodWindows(nowSeconds);
  return {
    allTimeSinceV3: {
      ...windows.allTimeSinceV3,
      ...sumDailySeriesWindow(
        series,
        windows.allTimeSinceV3.from,
        windows.allTimeSinceV3.to,
      ),
      partialReasons,
    },
    ytd: {
      ...windows.ytd,
      ...sumDailySeriesWindow(series, windows.ytd.from, windows.ytd.to),
      partialReasons,
    },
    last30d: {
      ...windows.last30d,
      ...sumDailySeriesWindow(series, windows.last30d.from, windows.last30d.to),
      partialReasons,
    },
    last7d: {
      ...windows.last7d,
      ...sumDailySeriesWindow(series, windows.last7d.from, windows.last7d.to),
      partialReasons,
    },
  };
}

function completedWindowAverage<T>(args: {
  points: ReadonlyArray<T>;
  value: (point: T) => number;
  timestamp: (point: T) => number;
  nowSeconds: number;
  trailingDays: number;
  minimumBuckets: number;
}): { dailyAverageUsd: number | null; buckets: number } {
  const today = currentDayBucket(args.nowSeconds);
  const from = today - args.trailingDays * SECONDS_PER_DAY;
  const values = new Map<number, number>();
  for (const point of args.points) {
    const timestamp = args.timestamp(point);
    const bucket = dayBucket(timestamp);
    if (bucket < from || bucket >= today) continue;
    values.set(bucket, (values.get(bucket) ?? 0) + args.value(point));
  }
  if (values.size < args.minimumBuckets) {
    return { dailyAverageUsd: null, buckets: values.size };
  }
  let total = 0;
  for (const value of values.values()) total += value;
  return { dailyAverageUsd: total / values.size, buckets: values.size };
}

function marketProtocolShareBps(
  market: CdpBorrowingRevenueMarket,
): number | null {
  if (market.spYieldSplitBps < 0 || market.spYieldSplitBps > 10_000) {
    return null;
  }
  return 10_000 - market.spYieldSplitBps;
}

function computeCdpInterestDailyRunRate(
  markets: ReadonlyArray<CdpBorrowingRevenueMarket>,
): { dailyUsd: number | null; partialReason: string | null } {
  let annualProtocolRunRateUsd = 0;
  for (const market of markets) {
    const protocolShareBps = marketProtocolShareBps(market);
    if (protocolShareBps === null) {
      return {
        dailyUsd: null,
        partialReason:
          "CDP forecast unavailable: live protocol split is not indexed for every market.",
      };
    }
    annualProtocolRunRateUsd +=
      market.annualInterestRunRateUSD * (protocolShareBps / 10_000);
  }
  return { dailyUsd: annualProtocolRunRateUsd / 365, partialReason: null };
}

function reserveForecastPartialReasons(
  reserveYield: ReserveYieldResponse,
): string[] {
  const reasons: string[] = [];
  const unavailableSymbols = reserveYield.forecastUnavailableSymbols;
  if (unavailableSymbols.length > 0) {
    reasons.push(
      `Reserve forecast excludes holdings without APY sources: ${unavailableSymbols.join(", ")}.`,
    );
  }
  if (reserveYield.holdingsError !== null) {
    reasons.push(
      "Reserve forecast partial: reserve holdings failed to load completely.",
    );
  }
  if (reserveYield.rateError !== null) {
    reasons.push(`Reserve forecast partial: ${reserveYield.rateError}`);
  }
  return reasons;
}

function buildForecastSource(args: {
  reserveYield: ReserveYieldResponse | null;
  swapSeries: ReadonlyArray<ReturnType<typeof buildDailyFeeSeries>[number]>;
  swapFeesFailed: boolean;
  swapFeesApproximate: boolean;
  cdpDailySeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>;
  cdpMarkets: ReadonlyArray<CdpBorrowingRevenueMarket>;
  cdpDailySeriesFailed: boolean;
  nowSeconds: number;
}): ForecastSource {
  const partialReasons: string[] = [];
  const reserveDailyUsd = finiteOrNull(args.reserveYield?.dailyRunRateUsd);
  const reserve30dUsd = finiteOrNull(args.reserveYield?.next30dUsd);
  const reserve365dUsd = finiteOrNull(args.reserveYield?.next365dUsd);
  if (args.reserveYield === null || reserveDailyUsd === null) {
    partialReasons.push(
      "Reserve forecast unavailable: current APY or reserve balances did not load.",
    );
  } else {
    partialReasons.push(...reserveForecastPartialReasons(args.reserveYield));
  }

  const swapAverage = args.swapFeesFailed
    ? { dailyAverageUsd: null, buckets: 0 }
    : completedWindowAverage({
        points: args.swapSeries,
        value: (point) => point.protocolFeesUSD + point.lpFeesUSD,
        timestamp: (point) => point.timestamp,
        nowSeconds: args.nowSeconds,
        trailingDays: 30,
        minimumBuckets: 7,
      });
  if (args.swapFeesFailed) {
    partialReasons.push(
      "Swap forecast unavailable: swap fee history failed to load.",
    );
  } else if (swapAverage.dailyAverageUsd === null) {
    partialReasons.push(
      `Swap forecast unavailable: only ${swapAverage.buckets} completed daily buckets loaded.`,
    );
  } else if (args.swapFeesApproximate) {
    partialReasons.push(
      "Swap forecast partial: swap fee history is approximate.",
    );
  }

  let cdpDailyUsd: number | null = null;
  if (args.cdpDailySeriesFailed) {
    partialReasons.push(
      "CDP forecast unavailable: borrowing revenue inputs failed to load.",
    );
  } else {
    const cdpInterest = computeCdpInterestDailyRunRate(args.cdpMarkets);
    if (cdpInterest.partialReason !== null) {
      partialReasons.push(cdpInterest.partialReason);
    }
    const cdpUpfrontAverage = completedWindowAverage({
      points: args.cdpDailySeries,
      value: (point) => point.upfrontFeesUSD,
      timestamp: (point) => point.timestamp,
      nowSeconds: args.nowSeconds,
      trailingDays: 30,
      minimumBuckets: 1,
    });
    const cdpUpfrontDailyUsd = cdpUpfrontAverage.dailyAverageUsd ?? 0;
    cdpDailyUsd =
      cdpInterest.dailyUsd === null
        ? null
        : cdpInterest.dailyUsd + cdpUpfrontDailyUsd;
  }

  return {
    reserveDailyUsd,
    reserve30dUsd,
    reserve365dUsd,
    swapDailyUsd: swapAverage.dailyAverageUsd,
    cdpDailyUsd,
    partialReasons,
  };
}

function forecastAssumption(days: number): string {
  return [
    "Forecast based on current reserve balances, trailing swap activity, and CDP current run-rate.",
    `Reserve uses non-compounding math: balance x APY x ${days} / 365.`,
    "AUSD is forecast-only until a payout ledger is wired; sUSDS actuals come from indexed earned-yield snapshots.",
    "Swap uses the last 30 completed daily fee buckets; CDP uses current protocol-share interest run-rate plus trailing upfront fees.",
  ].join("\n");
}

function buildForecast(
  source: ForecastSource,
  key: RevenueForecastKey,
  title: string,
  subtitle: string,
  days: number,
): CanonicalRevenueForecast {
  const reserveYieldUsd =
    days === 30
      ? source.reserve30dUsd
      : days === 365
        ? source.reserve365dUsd
        : source.reserveDailyUsd === null
          ? null
          : source.reserveDailyUsd * days;
  const swapFeesUsd =
    source.swapDailyUsd === null ? null : source.swapDailyUsd * days;
  const cdpBorrowingUsd =
    source.cdpDailyUsd === null ? null : source.cdpDailyUsd * days;
  const values = [reserveYieldUsd, swapFeesUsd, cdpBorrowingUsd].filter(
    (value): value is number => value !== null,
  );
  return {
    key,
    title,
    subtitle,
    days,
    totalUsd:
      values.length === 0
        ? null
        : values.reduce((sum, value) => sum + value, 0),
    reserveYieldUsd,
    swapFeesUsd,
    cdpBorrowingUsd,
    partialReasons: source.partialReasons,
    assumption: forecastAssumption(days),
  };
}

function buildForecasts(
  source: ForecastSource,
): Record<RevenueForecastKey, CanonicalRevenueForecast> {
  return {
    next7d: buildForecast(source, "next7d", "7d Forecast", "Next 7 days", 7),
    next30d: buildForecast(
      source,
      "next30d",
      "Monthly Forecast",
      "Next 30 days",
      30,
    ),
    next365d: buildForecast(
      source,
      "next365d",
      "Annual Forecast",
      "Next 365 days",
      365,
    ),
  };
}

function buildPartialReasons(args: BuildCanonicalRevenueArgs): string[] {
  const reasons: string[] = [];
  if (args.swapFeesFailed) reasons.push("Swap fee history failed to load.");
  if (args.cdpDailySeriesFailed) {
    reasons.push("CDP borrowing revenue history failed to load.");
  }
  if (args.reserveHistoryFailed) {
    reasons.push("Reserve earned-yield history failed to load.");
  } else if (args.reserveHistoryUnavailable) {
    reasons.push("Reserve earned-yield history is not indexed yet.");
  }
  if (args.reserveHistoryTruncated) {
    reasons.push("Reserve earned-yield history exceeded the pagination cap.");
  }
  return reasons;
}

function buildStreams(args: {
  periods: Record<RevenuePeriodKey, CanonicalRevenuePeriod>;
  forecasts: Record<RevenueForecastKey, CanonicalRevenueForecast>;
  reserveYield: ReserveYieldResponse | null;
  partialReasons: string[];
}): Record<CanonicalRevenueStream["key"], CanonicalRevenueStream> {
  const allPeriod = args.periods.allTimeSinceV3;
  const reservePartialReasons = args.partialReasons.filter((reason) =>
    reason.toLowerCase().includes("reserve"),
  );
  return {
    reserve: {
      key: "reserve",
      title: "Reserve Yield",
      actualUsd: allPeriod.reserveYieldUsd,
      forecast30dUsd: args.forecasts.next30d.reserveYieldUsd,
      forecast365dUsd: args.forecasts.next365d.reserveYieldUsd,
      subtitle:
        args.reserveYield?.principalUsd !== undefined
          ? "sUSDS actual yield; AUSD forecast-only"
          : "Reserve actuals from sUSDS snapshots",
      partialReasons: reservePartialReasons,
    },
    swap: {
      key: "swap",
      title: "Swap Fees",
      actualUsd: allPeriod.swapFeesUsd,
      forecast30dUsd: args.forecasts.next30d.swapFeesUsd,
      forecast365dUsd: args.forecasts.next365d.swapFeesUsd,
      subtitle: "Protocol fee snapshots across v3 pools",
      partialReasons: args.partialReasons.filter((reason) =>
        reason.toLowerCase().includes("swap"),
      ),
    },
    cdp: {
      key: "cdp",
      title: "CDP Borrowing Revenue",
      actualUsd: allPeriod.cdpBorrowingUsd,
      forecast30dUsd: args.forecasts.next30d.cdpBorrowingUsd,
      forecast365dUsd: args.forecasts.next365d.cdpBorrowingUsd,
      subtitle: "Protocol share of upfront fees and interest",
      partialReasons: args.partialReasons.filter((reason) =>
        reason.toLowerCase().includes("cdp"),
      ),
    },
  };
}

export function buildCanonicalRevenue({
  networkData,
  cdpDailySeries,
  cdpMarkets,
  reserveYield,
  reserveDailySnapshots,
  reserveHistoryUnavailable = false,
  reserveHistoryFailed = false,
  reserveHistoryTruncated = false,
  swapFeesFailed = false,
  swapFeesApproximate = false,
  cdpDailySeriesFailed = false,
  nowSeconds = Math.floor(Date.now() / 1000),
}: BuildCanonicalRevenueArgs): CanonicalRevenueResult {
  const swapSeries = buildDailyFeeSeries(
    [...networkData],
    undefined,
    nowSeconds,
  );
  const buckets = buildRevenueBuckets({
    swapSeries,
    cdpDailySeries,
    reserveDailySnapshots,
  });
  const dailySeries = buildDailySeries(buckets, nowSeconds);
  const partialReasons = buildPartialReasons({
    networkData,
    cdpDailySeries,
    cdpMarkets,
    reserveYield,
    reserveDailySnapshots,
    reserveHistoryUnavailable,
    reserveHistoryFailed,
    reserveHistoryTruncated,
    swapFeesFailed,
    cdpDailySeriesFailed,
    nowSeconds,
  });
  const periods = buildPeriods(dailySeries, nowSeconds, partialReasons);
  const forecasts = buildForecasts(
    buildForecastSource({
      reserveYield,
      swapSeries,
      swapFeesFailed,
      swapFeesApproximate,
      cdpDailySeries,
      cdpMarkets,
      cdpDailySeriesFailed,
      nowSeconds,
    }),
  );
  const streams = buildStreams({
    periods,
    forecasts,
    reserveYield,
    partialReasons,
  });

  return {
    periods,
    forecasts,
    dailySeries,
    streams,
    partialReasons,
  };
}
