"use client";

import { Suspense, useMemo } from "react";
import { PROTOCOL_FEE_RECIPIENT_ADDRESS } from "@mento-protocol/monitoring-config/protocol-fee";
import { formatUSD } from "@/lib/format";
import type { NetworkData } from "@/lib/fetch-all-networks";
import { useCdpBorrowingRevenue } from "@/hooks/use-cdp-borrowing-revenue";
import type { CdpBorrowingRevenueSummary } from "@/lib/cdp-borrowing-revenue";
import { useProtocolFees } from "@/hooks/use-protocol-fees";
import { BreakdownTile } from "@/components/breakdown-tile";
import { FeeOverTimeChart } from "@/components/fee-over-time-chart";
import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";
import { ComingSoonSection } from "@/components/coming-soon-section";

export function RevenuePageClient() {
  return (
    <Suspense>
      <RevenueContent />
    </Suspense>
  );
}

type FeeAggregation = {
  totalFeesAllTime: number | null;
  totalFees24h: number | null;
  totalFees7d: number | null;
  totalFees30d: number | null;
  unpricedSymbols: string[];
  totalUnresolvedCount: number;
};

type SwapFeesTileState = {
  aggregated: FeeAggregation;
  isLoading: boolean;
  hasError: boolean;
  isApproximate: boolean;
  isTruncated: boolean;
};

type CdpBorrowingFeesTileState = {
  summary: CdpBorrowingRevenueSummary | null;
  isLoading: boolean;
  hasError: boolean;
};

function aggregateSwapFees(
  networkData: ReadonlyArray<NetworkData>,
  hasFatalFeeError: boolean,
): FeeAggregation {
  if (hasFatalFeeError) {
    return {
      totalFeesAllTime: null,
      totalFees24h: null,
      totalFees7d: null,
      totalFees30d: null,
      unpricedSymbols: [],
      totalUnresolvedCount: 0,
    };
  }

  let totalFeesAllTime = 0;
  let totalFees24h = 0;
  let totalFees7d = 0;
  let totalFees30d = 0;
  const unpricedSymbolSet = new Set<string>();
  let totalUnresolvedCount = 0;

  for (const netData of networkData) {
    const { fees } = netData;
    if (netData.error !== null || fees === null) continue;

    totalFeesAllTime += fees.totalFeesUSD;
    totalFees24h += fees.fees24hUSD;
    totalFees7d += fees.fees7dUSD;
    totalFees30d += fees.fees30dUSD;
    for (const sym of fees.unpricedSymbols) unpricedSymbolSet.add(sym);
    totalUnresolvedCount += fees.unresolvedCount;
  }

  return {
    totalFeesAllTime,
    totalFees24h,
    totalFees7d,
    totalFees30d,
    unpricedSymbols: Array.from(unpricedSymbolSet).sort(),
    totalUnresolvedCount,
  };
}

function RevenueContent() {
  // Slim fees-only fetch. `useAllNetworksData` would pull paginated daily
  // snapshots, trading limits, OLS pools, LP addresses, and a breach rollup
  // per chain — none of which this page consumes. `useProtocolFees` returns
  // the same NetworkData shape with only the fees/rates slices populated.
  const { networkData, isLoading } = useProtocolFees();
  const {
    summary: cdpBorrowingRevenue,
    isLoading: isCdpBorrowingRevenueLoading,
    hasError: hasCdpBorrowingRevenueError,
  } = useCdpBorrowingRevenue();

  const anyNetworkError = networkData.some((n) => n.error !== null);
  // Tile + chart + leaderboard all read from snapshots since PR-snapshot-3.
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

  const aggregated = useMemo(
    () => aggregateSwapFees(networkData, hasSwapFeesError),
    [networkData, hasSwapFeesError],
  );

  const feesApprox =
    aggregated.unpricedSymbols.length > 0 ||
    aggregated.totalUnresolvedCount > 0 ||
    anyFeesTruncated;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Protocol Revenue</h1>
        <p className="text-sm text-slate-400">
          Revenue streams across all chains
        </p>
      </div>

      <RevenueSummaryTiles
        swapFees={{
          aggregated,
          isLoading,
          hasError: hasSwapFeesError,
          isApproximate: feesApprox,
          isTruncated: anyFeesTruncated,
        }}
        cdpBorrowingFees={{
          summary: cdpBorrowingRevenue,
          isLoading: isCdpBorrowingRevenueLoading,
          hasError: hasCdpBorrowingRevenueError,
        }}
      />

      <FeeOverTimeChart
        networkData={networkData}
        isLoading={isLoading}
        hasError={anyNetworkError}
        hasFeesError={anyFeesError}
        isApproximate={feesApprox}
      />

      <RevenueByPoolTable
        networkData={networkData}
        isLoading={isLoading}
        hasError={hasSwapFeesError}
      />

      <div className="grid grid-cols-1 gap-6">
        <ComingSoonSection
          title="Reserve Yield"
          description="Yield generated on reserve assets (USDS savings rate, etc.). Requires external data source integration."
        />
      </div>
    </div>
  );
}

function RevenueSummaryTiles({
  swapFees,
  cdpBorrowingFees,
}: {
  swapFees: SwapFeesTileState;
  cdpBorrowingFees: CdpBorrowingFeesTileState;
}) {
  return (
    <section>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SwapFeesTile state={swapFees} />
        <CdpBorrowingFeesTile state={cdpBorrowingFees} />
        <ReserveYieldTile />
      </div>
    </section>
  );
}

function swapFeesSubtitle(
  aggregated: FeeAggregation,
  isTruncated: boolean,
): string {
  if (isTruncated) return "Approximate — full history exceeds pagination cap";
  if (aggregated.unpricedSymbols.length > 0) {
    return `Approximate — unpriced: ${aggregated.unpricedSymbols.join(", ")}`;
  }
  if (aggregated.totalUnresolvedCount > 0) {
    return "Approximate — some tokens unresolved";
  }
  return "Protocol fee transfers to yield split address";
}

function SwapFeesTile({ state }: { state: SwapFeesTileState }) {
  const { aggregated, isLoading, hasError, isApproximate, isTruncated } = state;
  return (
    <BreakdownTile
      label="Swap Fees"
      total={aggregated.totalFeesAllTime}
      sub24h={aggregated.totalFees24h}
      sub7d={aggregated.totalFees7d}
      sub30d={aggregated.totalFees30d}
      isLoading={isLoading}
      hasError={hasError}
      format={formatUSD}
      totalPrefix={isApproximate ? "≈ " : ""}
      href={`https://debank.com/profile/${PROTOCOL_FEE_RECIPIENT_ADDRESS}`}
      subtitle={swapFeesSubtitle(aggregated, isTruncated)}
    />
  );
}

function CdpBorrowingFeesTile({ state }: { state: CdpBorrowingFeesTileState }) {
  const { summary, isLoading, hasError } = state;
  const isApproximate = (summary?.unpricedSymbols.length ?? 0) > 0;
  const mainValue = isLoading
    ? "…"
    : hasError || summary === null
      ? "N/A"
      : `${isApproximate ? "≈ " : ""}${formatUSD(summary.totalRevenueUSD)}`;
  const componentItems =
    !isLoading && !hasError && summary !== null
      ? [
          { label: "Upfront", value: summary.upfrontFeesUSD },
          { label: "Interest", value: summary.accruedInterestUSD },
        ]
      : null;
  const subtitle =
    hasError || summary === null
      ? "Unable to load CDP borrowing fees"
      : isApproximate
        ? `Approximate — unpriced debt token${summary.unpricedSymbols.length === 1 ? "" : "s"}: ${summary.unpricedSymbols.join(", ")}`
        : "Upfront fees plus accrued interest from Liquity v2";

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px]">
      <div>
        <p className="text-sm text-slate-400">CDP Borrowing Fees</p>
        <p className="mt-1 text-2xl font-semibold text-white font-mono">
          {mainValue}
        </p>
        {componentItems && (
          <div className="mt-1.5 flex gap-3 text-sm font-mono">
            {componentItems.map((item) => (
              <span key={item.label}>
                <span className="text-slate-500">{item.label}</span>{" "}
                <span className="text-slate-400">{formatUSD(item.value)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500 min-h-4">{subtitle}</p>
    </div>
  );
}

function ReserveYieldTile() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex flex-col justify-between min-h-[88px] opacity-60">
      <div>
        <div className="flex items-center gap-2">
          <p className="text-sm text-slate-400">Reserve Yield</p>
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
            Soon
          </span>
        </div>
        <p className="mt-1 text-2xl font-semibold text-slate-600 font-mono">
          —
        </p>
      </div>
      <p className="mt-2 text-xs text-slate-600 min-h-4">
        Requires external data integration
      </p>
    </div>
  );
}
