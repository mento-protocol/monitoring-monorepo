import { buildDailyFeeSeries } from "@/lib/revenue";
import {
  buildActualAvailability,
  buildPartialReasons,
} from "./canonical-revenue/actuals";
import {
  buildRevenueBuckets,
  buildDailySeries,
} from "./canonical-revenue/daily-series";
import {
  buildForecastSource,
  buildForecasts,
} from "./canonical-revenue/forecasts";
import { buildPeriods } from "./canonical-revenue/periods";
import { buildStreams } from "./canonical-revenue/streams";
import type {
  BuildCanonicalRevenueArgs,
  CanonicalRevenueResult,
} from "./canonical-revenue/types";

export {
  V3_REVENUE_LAUNCH_LABEL,
  V3_REVENUE_LAUNCH_TIMESTAMP,
} from "./canonical-revenue/constants";
export type {
  BuildCanonicalRevenueArgs,
  CanonicalRevenueDailyPoint,
  CanonicalRevenueForecast,
  CanonicalRevenuePeriod,
  CanonicalRevenueResult,
  CanonicalRevenueStream,
  RevenueForecastKey,
  RevenuePeriodKey,
  SusdsYieldDailySnapshotRow,
} from "./canonical-revenue/types";

export function buildCanonicalRevenue({
  networkData,
  cdpDailySeries,
  cdpMarkets,
  reserveYield,
  reserveDailySnapshots,
  reserveHistoryUnavailable = false,
  reserveHistoryFailed = false,
  reserveHistoryTruncated = false,
  reserveYieldFailed = false,
  swapFeesFailed = false,
  swapFeesApproximate = false,
  cdpDailySeriesFailed = false,
  cdpInputsApproximate = false,
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
  const canonicalArgs = {
    networkData,
    cdpDailySeries,
    cdpMarkets,
    reserveYield,
    reserveDailySnapshots,
    reserveHistoryUnavailable,
    reserveHistoryFailed,
    reserveHistoryTruncated,
    reserveYieldFailed,
    swapFeesFailed,
    swapFeesApproximate,
    cdpDailySeriesFailed,
    cdpInputsApproximate,
    nowSeconds,
  };
  const actualAvailability = buildActualAvailability(canonicalArgs);
  const dailySeries = buildDailySeries(buckets, nowSeconds, actualAvailability);
  const partialReasons = buildPartialReasons(canonicalArgs);
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
      cdpInputsApproximate,
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
