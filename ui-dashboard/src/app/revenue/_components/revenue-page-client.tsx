"use client";

import { Suspense, useMemo } from "react";
import type { NetworkData } from "@/lib/fetch-all-networks";
import { useCdpBorrowingRevenue } from "@/hooks/use-cdp-borrowing-revenue";
import { useReserveYield } from "@/hooks/use-reserve-yield";
import { useReserveYieldHistory } from "@/hooks/use-reserve-yield-history";
import { useCanonicalRevenue } from "@/hooks/use-canonical-revenue";
import { useProtocolFees } from "@/hooks/use-protocol-fees";
import { TotalRevenueChart } from "@/components/fee-over-time-chart";
import { ReserveYieldByHoldingTable } from "./reserve-yield-components";
import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";
import { V3_REVENUE_LAUNCH_LABEL } from "@/lib/canonical-revenue";
import { CdpBorrowingFeesByMarketTable } from "./cdp-borrowing-fees-table";
import {
  ForecastCards,
  RevenuePeriodCards,
  RevenueStreamCards,
} from "./revenue-summary-cards";

function hasApproximateCdpForecastInputs(args: {
  dailySeriesTruncated: boolean;
  dailySeriesFailed: boolean;
  hasRevenueError: boolean;
  unpricedSymbolCount: number;
  bracketsTruncated: boolean;
}): boolean {
  if (args.hasRevenueError || args.dailySeriesFailed) return false;
  return (
    args.dailySeriesTruncated ||
    args.unpricedSymbolCount > 0 ||
    args.bracketsTruncated
  );
}

export function RevenuePageClient() {
  return (
    <Suspense>
      <RevenueContent />
    </Suspense>
  );
}

function useRevenuePageState() {
  // Slim fees-only fetch. `useAllNetworksData` would pull paginated daily
  // snapshots, trading limits, OLS pools, LP addresses, and a breach rollup
  // per chain — none of which this page consumes. `useProtocolFees` returns
  // the same NetworkData shape with only the fees/rates slices populated.
  const { networkData, isLoading } = useProtocolFees();
  const {
    summary: cdpBorrowingRevenue,
    markets: cdpBorrowingMarkets,
    dailySeries: cdpBorrowingFeeSeries,
    dailySeriesTruncated: cdpBorrowingFeeSeriesTruncated,
    dailySeriesFailed: cdpBorrowingFeeSeriesFailed,
    isLoading: isCdpBorrowingRevenueLoading,
    hasError: hasCdpBorrowingRevenueError,
  } = useCdpBorrowingRevenue();
  const reserveYieldState = useReserveYield();
  const reserveYieldHistory = useReserveYieldHistory();

  const anyNetworkError = networkData.some((n) => n.error !== null);
  // Tile + chart + table all read from snapshots since PR-snapshot-3.
  // Either rates or snapshot fetch failure blanks the fee surfaces.
  const anyFeesError = networkData.some(
    (n) =>
      (n.ratesError !== null || n.feeSnapshotsError !== null) &&
      n.error === null,
  );
  // Pagination cap exhausted on at least one chain — totals are a lower
  // bound. Surface as `≈` rather than blanking, since most history is in.
  const anyFeesTruncated = networkData.some(
    (n) => n.feeSnapshotsTruncated && n.error === null,
  );
  const hasSwapFeesError = anyNetworkError || anyFeesError;
  const feesApprox = hasApproximateFees(networkData) || anyFeesTruncated;
  const cdpInputsApproximate = hasApproximateCdpForecastInputs({
    dailySeriesTruncated: cdpBorrowingFeeSeriesTruncated,
    dailySeriesFailed: cdpBorrowingFeeSeriesFailed,
    hasRevenueError: hasCdpBorrowingRevenueError,
    unpricedSymbolCount: cdpBorrowingRevenue?.unpricedSymbols.length ?? 0,
    bracketsTruncated: cdpBorrowingRevenue?.bracketsTruncated ?? false,
  });

  const canonicalRevenue = useCanonicalRevenue({
    networkData,
    cdpDailySeries: cdpBorrowingFeeSeries,
    cdpMarkets: cdpBorrowingMarkets,
    reserveYield: reserveYieldState.data,
    reserveDailySnapshots: reserveYieldHistory.rows,
    reserveHistoryUnavailable: reserveYieldHistory.unavailable,
    reserveHistoryFailed: reserveYieldHistory.hasError,
    reserveHistoryTruncated: reserveYieldHistory.truncated,
    reserveYieldFailed: reserveYieldState.hasError,
    swapFeesFailed: hasSwapFeesError,
    swapFeesApproximate: feesApprox && !hasSwapFeesError,
    cdpDailySeriesFailed:
      hasCdpBorrowingRevenueError || cdpBorrowingFeeSeriesFailed,
    cdpInputsApproximate,
  });

  const isRevenueLoading =
    isLoading ||
    isCdpBorrowingRevenueLoading ||
    reserveYieldState.isLoading ||
    reserveYieldHistory.isLoading;

  const actualPartialReasons = useMemo(() => {
    const reasons = [...canonicalRevenue.partialReasons];
    if (feesApprox && !hasSwapFeesError) {
      reasons.push("Swap fee history is approximate.");
    }
    if (cdpInputsApproximate) {
      reasons.push("CDP borrowing history is approximate.");
    }
    return [...new Set(reasons)];
  }, [
    canonicalRevenue.partialReasons,
    feesApprox,
    hasSwapFeesError,
    cdpInputsApproximate,
  ]);

  return {
    networkData,
    isLoading,
    cdpBorrowingMarkets,
    isCdpBorrowingRevenueLoading,
    hasCdpBorrowingRevenueError,
    reserveYieldState,
    canonicalRevenue,
    isRevenueLoading,
    actualPartialReasons,
    hasSwapFeesError,
  };
}

function hasApproximateFees(networkData: ReadonlyArray<NetworkData>): boolean {
  return networkData.some(
    (netData) =>
      netData.fees?.unpricedSymbols.length || netData.fees?.unresolvedCount,
  );
}

function RevenueContent() {
  const {
    networkData,
    isLoading,
    cdpBorrowingMarkets,
    isCdpBorrowingRevenueLoading,
    hasCdpBorrowingRevenueError,
    reserveYieldState,
    canonicalRevenue,
    isRevenueLoading,
    actualPartialReasons,
    hasSwapFeesError,
  } = useRevenuePageState();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Protocol Revenue</h1>
        <p className="text-sm text-slate-400">
          Canonical revenue actuals since {V3_REVENUE_LAUNCH_LABEL}, plus
          forward forecasts by stream
        </p>
      </div>

      <RevenuePeriodCards
        periods={canonicalRevenue.periods}
        isLoading={isRevenueLoading}
        partialReasons={actualPartialReasons}
      />

      <ForecastCards
        forecasts={canonicalRevenue.forecasts}
        isLoading={isRevenueLoading}
      />

      <RevenueStreamCards
        streams={[
          canonicalRevenue.streams.reserve,
          canonicalRevenue.streams.swap,
          canonicalRevenue.streams.cdp,
        ]}
        isLoading={isRevenueLoading}
        actualPartialReasons={actualPartialReasons}
      />

      <TotalRevenueChart
        series={canonicalRevenue.dailySeries}
        isLoading={isRevenueLoading}
        partialReasons={actualPartialReasons}
      />

      <div className="grid grid-cols-1 gap-6">
        <ReserveYieldByHoldingTable
          data={reserveYieldState.data}
          isLoading={reserveYieldState.isLoading}
          hasError={reserveYieldState.hasError}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        <RevenueByPoolTable
          networkData={networkData}
          isLoading={isLoading}
          hasError={hasSwapFeesError}
        />
        <CdpBorrowingFeesByMarketTable
          markets={cdpBorrowingMarkets}
          isLoading={isCdpBorrowingRevenueLoading}
          hasError={hasCdpBorrowingRevenueError}
        />
      </div>
    </div>
  );
}
