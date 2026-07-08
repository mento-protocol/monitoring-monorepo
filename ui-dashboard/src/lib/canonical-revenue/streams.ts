import type {
  CanonicalRevenueForecast,
  CanonicalRevenuePeriod,
  CanonicalRevenueStream,
  RevenueForecastKey,
  RevenuePeriodKey,
} from "./types";
import { streamKeyToNeedle } from "./utils";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";

function partialReasonsForStream(args: {
  streamKey: CanonicalRevenueStream["key"];
  reasons: readonly string[];
}): string[] {
  const needle = streamKeyToNeedle(args.streamKey);
  return [
    ...new Set(
      args.reasons.filter((reason) => reason.toLowerCase().includes(needle)),
    ),
  ];
}

function forecastPartialReasonsForStream(args: {
  streamKey: CanonicalRevenueStream["key"];
  forecasts: Record<RevenueForecastKey, CanonicalRevenueForecast>;
}): string[] {
  return partialReasonsForStream({
    streamKey: args.streamKey,
    reasons: [
      ...args.forecasts.next7d.partialReasons,
      ...args.forecasts.next30d.partialReasons,
      ...args.forecasts.next365d.partialReasons,
    ],
  });
}

export function buildStreams(args: {
  periods: Record<RevenuePeriodKey, CanonicalRevenuePeriod>;
  forecasts: Record<RevenueForecastKey, CanonicalRevenueForecast>;
  reserveYield: ReserveYieldResponse | null;
  partialReasons: string[];
}): Record<CanonicalRevenueStream["key"], CanonicalRevenueStream> {
  const allPeriod = args.periods.allTimeSinceV3;
  const reserveActualPartialReasons = partialReasonsForStream({
    streamKey: "reserve",
    reasons: args.partialReasons,
  });
  const reserveForecastPartialReasons = forecastPartialReasonsForStream({
    streamKey: "reserve",
    forecasts: args.forecasts,
  });
  const swapActualPartialReasons = partialReasonsForStream({
    streamKey: "swap",
    reasons: args.partialReasons,
  });
  const swapForecastPartialReasons = forecastPartialReasonsForStream({
    streamKey: "swap",
    forecasts: args.forecasts,
  });
  const cdpActualPartialReasons = partialReasonsForStream({
    streamKey: "cdp",
    reasons: args.partialReasons,
  });
  const cdpForecastPartialReasons = forecastPartialReasonsForStream({
    streamKey: "cdp",
    forecasts: args.forecasts,
  });
  return {
    reserve: {
      key: "reserve",
      title: "Reserve Yield",
      actualUsd: allPeriod.reserveYieldUsd,
      forecast30dUsd: args.forecasts.next30d.reserveYieldUsd,
      forecast365dUsd: args.forecasts.next365d.reserveYieldUsd,
      subtitle:
        args.reserveYield !== null
          ? "sUSDS and stETH actual yield when indexed; AUSD forecast-only"
          : "Reserve actuals from indexed earned-yield snapshots",
      actualPartialReasons: reserveActualPartialReasons,
      forecastPartialReasons: reserveForecastPartialReasons,
      partialReasons: [
        ...new Set([
          ...reserveActualPartialReasons,
          ...reserveForecastPartialReasons,
        ]),
      ],
    },
    swap: {
      key: "swap",
      title: "Swap Fees",
      actualUsd: allPeriod.swapFeesUsd,
      forecast30dUsd: args.forecasts.next30d.swapFeesUsd,
      forecast365dUsd: args.forecasts.next365d.swapFeesUsd,
      subtitle: "Protocol fee snapshots across v3 pools",
      actualPartialReasons: swapActualPartialReasons,
      forecastPartialReasons: swapForecastPartialReasons,
      partialReasons: [
        ...new Set([
          ...swapActualPartialReasons,
          ...swapForecastPartialReasons,
        ]),
      ],
    },
    cdp: {
      key: "cdp",
      title: "CDP Borrowing Revenue",
      actualUsd: allPeriod.cdpBorrowingUsd,
      forecast30dUsd: args.forecasts.next30d.cdpBorrowingUsd,
      forecast365dUsd: args.forecasts.next365d.cdpBorrowingUsd,
      subtitle: "Protocol share of upfront fees and interest",
      actualPartialReasons: cdpActualPartialReasons,
      forecastPartialReasons: cdpForecastPartialReasons,
      partialReasons: [
        ...new Set([...cdpActualPartialReasons, ...cdpForecastPartialReasons]),
      ],
    },
  };
}
