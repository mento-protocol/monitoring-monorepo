import { SECONDS_PER_DAY } from "@/lib/time-series";
import {
  V3_REVENUE_LAUNCH_LABEL,
  V3_REVENUE_LAUNCH_TIMESTAMP,
} from "./constants";
import { currentDayBucket, isoDate } from "./utils";
import type {
  CanonicalRevenueDailyPoint,
  CanonicalRevenuePeriod,
  RevenuePeriodKey,
} from "./types";

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
> & { availableTotalUsd: number } {
  let reserveYieldUsd = 0;
  let swapFeesUsd = 0;
  let cdpBorrowingUsd = 0;
  let reserveYieldUnavailable = false;
  let swapFeesUnavailable = false;
  let cdpBorrowingUnavailable = false;
  for (const point of series) {
    if (point.timestamp < from || point.timestamp >= to) continue;
    if (point.reserveYieldUsd === null) {
      reserveYieldUnavailable = true;
    } else {
      reserveYieldUsd += point.reserveYieldUsd;
    }
    if (point.swapFeesUsd === null) {
      swapFeesUnavailable = true;
    } else {
      swapFeesUsd += point.swapFeesUsd;
    }
    if (point.cdpBorrowingUsd === null) {
      cdpBorrowingUnavailable = true;
    } else {
      cdpBorrowingUsd += point.cdpBorrowingUsd;
    }
  }
  const availableTotalUsd = reserveYieldUsd + swapFeesUsd + cdpBorrowingUsd;
  const totalUnavailable =
    reserveYieldUnavailable || swapFeesUnavailable || cdpBorrowingUnavailable;
  return {
    reserveYieldUsd: reserveYieldUnavailable ? null : reserveYieldUsd,
    swapFeesUsd: swapFeesUnavailable ? null : swapFeesUsd,
    cdpBorrowingUsd: cdpBorrowingUnavailable ? null : cdpBorrowingUsd,
    availableTotalUsd,
    totalUsd: totalUnavailable ? null : availableTotalUsd,
  };
}

export function buildPeriods(
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
