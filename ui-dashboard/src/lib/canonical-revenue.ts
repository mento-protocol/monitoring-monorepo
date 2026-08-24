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
import { hasInvalidSusdsYieldDailySnapshotRow } from "./canonical-revenue/reserve-snapshot-validation";
import { isValidStethYieldDailySnapshotRow } from "./canonical-revenue/steth-snapshot-validation";
import type {
  BuildCanonicalRevenueArgs,
  CanonicalRevenueResult,
  ReserveYieldDailySnapshotRow,
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
  ReserveYieldDailySnapshotRow,
  StethYieldDailySnapshotRow,
  SusdsYieldDailySnapshotRow,
} from "./canonical-revenue/types";

function hasWalletField(value: unknown): boolean {
  return typeof value === "object" && value !== null && "wallet" in value;
}

function validateReserveHistory(
  rows: ReadonlyArray<ReserveYieldDailySnapshotRow>,
): {
  rows: ReadonlyArray<ReserveYieldDailySnapshotRow>;
  malformedSusdsHistory: boolean;
  malformedStethHistory: boolean;
} {
  const malformedSusdsHistory = hasInvalidSusdsYieldDailySnapshotRow(rows);
  const malformedStethHistory = rows.some(
    (row) => hasWalletField(row) && !isValidStethYieldDailySnapshotRow(row),
  );
  return {
    rows: malformedSusdsHistory
      ? []
      : rows.filter(
          (row) =>
            !hasWalletField(row) || isValidStethYieldDailySnapshotRow(row),
        ),
    malformedSusdsHistory,
    malformedStethHistory,
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
  stethHistoryFailed = false,
  hasStethSnapshotSource,
  reserveYieldFailed = false,
  reserveCurrentHoldingsClassificationFailed = false,
  hasUnindexedSusdsHolding = false,
  swapFeesFailed = false,
  swapFeesApproximate = false,
  cdpDailySeriesFailed = false,
  cdpInputsApproximate = false,
  nowSeconds = Math.floor(Date.now() / 1000),
}: BuildCanonicalRevenueArgs): CanonicalRevenueResult {
  const validatedReserveHistory = validateReserveHistory(reserveDailySnapshots);
  const validatedReserveDailySnapshots = validatedReserveHistory.rows;
  const swapSeries = buildDailyFeeSeries(
    [...networkData],
    undefined,
    nowSeconds,
  );
  const reserveBuckets = buildRevenueBuckets({
    swapSeries,
    cdpDailySeries,
    reserveDailySnapshots: validatedReserveDailySnapshots,
    reserveYield,
  });
  const canonicalArgs = {
    networkData,
    cdpDailySeries,
    cdpMarkets,
    reserveYield,
    reserveDailySnapshots: validatedReserveDailySnapshots,
    reserveHistoryUnavailable,
    reserveHistoryFailed:
      reserveHistoryFailed || validatedReserveHistory.malformedSusdsHistory,
    reserveHistoryTruncated,
    stethHistoryFailed:
      stethHistoryFailed || validatedReserveHistory.malformedStethHistory,
    hasStethSnapshotSource,
    reserveHistoryUnpriced: reserveBuckets.reserveHistoryUnpriced,
    reserveYieldFailed,
    reserveCurrentHoldingsClassificationFailed,
    hasUnindexedSusdsHolding,
    swapFeesFailed,
    swapFeesApproximate,
    cdpDailySeriesFailed,
    cdpInputsApproximate,
    nowSeconds,
  };
  const actualAvailability = buildActualAvailability(canonicalArgs);
  const dailySeries = buildDailySeries(
    reserveBuckets.buckets,
    nowSeconds,
    actualAvailability,
  );
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
