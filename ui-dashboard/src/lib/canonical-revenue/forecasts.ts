import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
} from "@/lib/cdp-borrowing-revenue";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import { buildDailyFeeSeries } from "@/lib/revenue";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { V3_REVENUE_LAUNCH_TIMESTAMP } from "./constants";
import { currentDayBucket, dayBucket, finiteOrNull } from "./utils";
import type { CanonicalRevenueForecast, RevenueForecastKey } from "./types";

type SwapDailyFeePoint = ReturnType<typeof buildDailyFeeSeries>[number];

type ForecastSource = {
  reserveDailyUsd: number | null;
  reserve30dUsd: number | null;
  reserve365dUsd: number | null;
  swapDailyUsd: number | null;
  cdpDailyUsd: number | null;
  partialReasons: string[];
};

function completedWindowAverage<T>(args: {
  points: ReadonlyArray<T>;
  value: (point: T) => number;
  timestamp: (point: T) => number;
  nowSeconds: number;
  trailingDays: number;
  minimumBuckets: number;
  minimumTimestamp?: number;
}): { dailyAverageUsd: number | null; buckets: number } {
  const today = currentDayBucket(args.nowSeconds);
  const from = Math.max(
    today - args.trailingDays * SECONDS_PER_DAY,
    args.minimumTimestamp === undefined
      ? Number.NEGATIVE_INFINITY
      : dayBucket(args.minimumTimestamp),
  );
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
      `Reserve forecast excludes holdings without annual-rate sources: ${unavailableSymbols.join(", ")}.`,
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

export function buildForecastSource(args: {
  reserveYield: ReserveYieldResponse | null;
  swapSeries: ReadonlyArray<SwapDailyFeePoint>;
  swapFeesFailed: boolean;
  swapFeesApproximate: boolean;
  cdpDailySeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>;
  cdpMarkets: ReadonlyArray<CdpBorrowingRevenueMarket>;
  cdpDailySeriesFailed: boolean;
  cdpInputsApproximate: boolean;
  nowSeconds: number;
}): ForecastSource {
  const partialReasons: string[] = [];
  const reserveDailyUsd = finiteOrNull(args.reserveYield?.dailyRunRateUsd);
  const reserve30dUsd = finiteOrNull(args.reserveYield?.next30dUsd);
  const reserve365dUsd = finiteOrNull(args.reserveYield?.next365dUsd);
  if (args.reserveYield === null || reserveDailyUsd === null) {
    partialReasons.push(
      "Reserve forecast unavailable: current annual rate or reserve balances did not load.",
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
        minimumTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
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
    if (args.cdpInputsApproximate) {
      partialReasons.push(
        "CDP forecast partial: borrowing revenue inputs are approximate.",
      );
    }
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
      minimumTimestamp: V3_REVENUE_LAUNCH_TIMESTAMP,
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
    `Reserve uses non-compounding forecast math: balance x annual rate x ${days} / 365.`,
    "AUSD is forecast-only; sUSDS and stETH actuals come from indexed earned-yield snapshots when available.",
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

export function buildForecasts(
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
