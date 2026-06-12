"use client";

import { useMemo } from "react";
import {
  buildCanonicalRevenue,
  type CanonicalRevenueResult,
  type SusdsYieldDailySnapshotRow,
} from "@/lib/canonical-revenue";
import type { NetworkData } from "@/lib/fetch-all-networks";
import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
} from "@/lib/cdp-borrowing-revenue";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";

export type UseCanonicalRevenueArgs = {
  networkData: ReadonlyArray<NetworkData>;
  cdpDailySeries: ReadonlyArray<CdpBorrowingFeeSeriesPoint>;
  cdpMarkets: ReadonlyArray<CdpBorrowingRevenueMarket>;
  reserveYield: ReserveYieldResponse | null;
  reserveDailySnapshots: ReadonlyArray<SusdsYieldDailySnapshotRow>;
  reserveHistoryUnavailable: boolean;
  reserveHistoryFailed: boolean;
  reserveHistoryTruncated: boolean;
  swapFeesFailed: boolean;
  cdpDailySeriesFailed: boolean;
};

export function useCanonicalRevenue(
  args: UseCanonicalRevenueArgs,
): CanonicalRevenueResult {
  const {
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
  } = args;

  return useMemo(
    () =>
      buildCanonicalRevenue({
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
      }),
    [
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
    ],
  );
}
