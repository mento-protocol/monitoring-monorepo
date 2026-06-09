"use client";

import { Suspense, useMemo, type ReactNode } from "react";
import { PROTOCOL_FEE_RECIPIENT_ADDRESS } from "@mento-protocol/monitoring-config/protocol-fee";
import { formatUSD } from "@/lib/format";
import type { NetworkData } from "@/lib/fetch-all-networks";
import { useCdpBorrowingRevenue } from "@/hooks/use-cdp-borrowing-revenue";
import type {
  CdpBorrowingRevenueMarket,
  CdpBorrowingRevenueSummary,
} from "@/lib/cdp-borrowing-revenue";
import { useProtocolFees } from "@/hooks/use-protocol-fees";
import { BreakdownTile } from "@/components/breakdown-tile";
import { FeeOverTimeChart } from "@/components/fee-over-time-chart";
import { InfoPopover } from "@/components/info-popover";
import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";
import { ComingSoonSection } from "@/components/coming-soon-section";
import { Row, Table, Td, Th } from "@/components/table";

const CDP_BORROWING_HEADER_INFO = {
  debt: "Active CDP debt, priced to USD from the debt token's live oracle rate.",
  runRate:
    "Annualized interest revenue if current debt and rates stay unchanged.",
  upfront:
    "Cumulative one-time borrowing fees paid when troves are opened or debt is increased.",
  interest:
    "Accrued interest earned so far, including live accrual since the last indexer update.",
  total: "Upfront fees plus accrued interest.",
} as const;

const CDP_AVERAGE_APR_INFO = (
  <span className="block space-y-1.5">
    <span className="block">
      Debt-weighted average APR on active debt. Larger troves count more than
      smaller troves.
    </span>
    <span className="block rounded border border-slate-700/70 bg-slate-950/70 px-2 py-1">
      <span className="font-sans text-slate-500">Formula: </span>
      <span className="font-mono text-slate-100">Σ(debt × APR) / Σ(debt)</span>
    </span>
  </span>
);

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
    markets: cdpBorrowingMarkets,
    dailySeries: cdpBorrowingFeeSeries,
    dailySeriesTruncated: cdpBorrowingFeeSeriesTruncated,
    dailySeriesApproximate: cdpBorrowingFeeSeriesApproximate,
    isLoading: isCdpBorrowingRevenueLoading,
    hasError: hasCdpBorrowingRevenueError,
  } = useCdpBorrowingRevenue();

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

  const aggregated = useMemo(
    () => aggregateSwapFees(networkData, hasSwapFeesError),
    [networkData, hasSwapFeesError],
  );

  const feesApprox =
    aggregated.unpricedSymbols.length > 0 ||
    aggregated.totalUnresolvedCount > 0 ||
    anyFeesTruncated;
  const borrowingFeesChartApprox =
    cdpBorrowingFeeSeriesApproximate ||
    cdpBorrowingFeeSeriesTruncated ||
    (cdpBorrowingRevenue?.unpricedSymbols.length ?? 0) > 0 ||
    (cdpBorrowingRevenue?.bracketsTruncated ?? false);

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
        borrowingFeeSeries={cdpBorrowingFeeSeries}
        isLoading={isLoading}
        isBorrowingFeesLoading={isCdpBorrowingRevenueLoading}
        hasError={anyNetworkError}
        hasFeesError={anyFeesError}
        hasBorrowingFeesError={hasCdpBorrowingRevenueError}
        isApproximate={feesApprox}
        isBorrowingFeesApproximate={borrowingFeesChartApprox}
      />

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
  const isApproximate =
    (summary?.unpricedSymbols.length ?? 0) > 0 ||
    (summary?.bracketsTruncated ?? false);
  const mainValue = isLoading
    ? "—"
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
  const subtitle = cdpBorrowingFeesSubtitle(summary, isLoading, hasError);

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

function cdpBorrowingFeesSubtitle(
  summary: CdpBorrowingRevenueSummary | null,
  isLoading: boolean,
  hasError: boolean,
): string {
  if (isLoading) return "Loading CDP borrowing fees";
  if (hasError || summary === null) return "Unable to load CDP borrowing fees";
  if (summary.bracketsTruncated) {
    return "Approximate — interest brackets exceed pagination cap";
  }
  if (summary.unpricedSymbols.length > 0) {
    return `Approximate — unpriced debt token${summary.unpricedSymbols.length === 1 ? "" : "s"}: ${summary.unpricedSymbols.join(", ")}`;
  }
  const marketLabel =
    summary.marketCount === 1
      ? "1 Celo CDP market"
      : `${summary.marketCount} Celo CDP markets`;
  return `Across ${marketLabel}; upfront fees plus accrued interest`;
}

function MarketFeeCell({
  value,
  approximate,
  title,
}: {
  value: number;
  approximate: boolean;
  title: string | undefined;
}) {
  return (
    <Td mono align="right" className="sm:!px-2" {...(title ? { title } : {})}>
      {approximate ? "≈ " : ""}
      {formatUSD(value)}
    </Td>
  );
}

function MarketPercentCell({
  value,
  title,
}: {
  value: number | null;
  title: string | undefined;
}) {
  return (
    <Td mono align="right" className="sm:!px-2" {...(title ? { title } : {})}>
      {formatAnnualInterestRatePercent(value)}
    </Td>
  );
}

function formatAnnualInterestRatePercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = Math.abs(value) < 10 ? 2 : 1;
  return `${value.toFixed(digits).replace(/\.?0+$/, "")}%`;
}

function marketApproxTitle(
  market: CdpBorrowingRevenueMarket,
): string | undefined {
  if (market.bracketsTruncated) {
    return "Interest brackets exceeded the pagination cap; totals are a lower bound.";
  }
  if (market.unpricedSymbols.length > 0) {
    return `Unpriced debt token${market.unpricedSymbols.length === 1 ? "" : "s"}: ${market.unpricedSymbols.join(", ")}`;
  }
  return undefined;
}

function RevenueTableShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
      {children}
    </div>
  );
}

function CdpBorrowingHeaderInfo({
  label,
  content,
  tooltipAlign = "left",
}: {
  label: string;
  content: ReactNode;
  tooltipAlign?: "left" | "right";
}) {
  return (
    <InfoPopover
      label={`About ${label}`}
      content={content}
      tooltipAlign={tooltipAlign}
    >
      {label}
    </InfoPopover>
  );
}

function CdpBorrowingFeesMarketRow({
  market,
}: {
  market: CdpBorrowingRevenueMarket;
}) {
  const title = marketApproxTitle(market);
  const approximate = title !== undefined;
  return (
    <Row>
      <Td
        className="w-12 whitespace-nowrap sm:!pl-2 sm:!pr-1"
        title={`${market.activeTroveCount.toLocaleString()} active trove${market.activeTroveCount === 1 ? "" : "s"}`}
      >
        <span className="font-semibold text-sm text-slate-100">
          {market.symbol}
        </span>
      </Td>
      <MarketFeeCell
        value={market.activeDebtUSD}
        approximate={approximate}
        title={title}
      />
      <MarketPercentCell
        value={market.averageAnnualInterestRatePercent}
        title={title}
      />
      <MarketFeeCell
        value={market.annualInterestRunRateUSD}
        approximate={approximate}
        title={title}
      />
      <MarketFeeCell
        value={market.upfrontFeesUSD}
        approximate={approximate}
        title={title}
      />
      <MarketFeeCell
        value={market.accruedInterestUSD}
        approximate={approximate}
        title={title}
      />
      <MarketFeeCell
        value={market.totalRevenueUSD}
        approximate={approximate}
        title={title}
      />
    </Row>
  );
}

function CdpBorrowingFeesByMarketTable({
  markets,
  isLoading,
  hasError,
}: {
  markets: CdpBorrowingRevenueMarket[];
  isLoading: boolean;
  hasError: boolean;
}) {
  if (markets.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">
          Borrowing Fees by CDP
        </h2>
        <RevenueTableShell>
          {isLoading
            ? "Loading…"
            : hasError
              ? "Couldn't load CDP borrowing revenue."
              : "No CDP borrowing revenue indexed yet."}
        </RevenueTableShell>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-white">
        Borrowing Fees by CDP
      </h2>
      {hasError ? (
        <p className="mb-3 text-xs text-amber-400/80">
          One or more CDP markets failed to load — showing partial data.
        </p>
      ) : null}
      <Table aria-label="Borrowing fees by CDP market">
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <Th className="w-12 sm:!pl-2 sm:!pr-1">CDP</Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Debt"
                content={CDP_BORROWING_HEADER_INFO.debt}
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="ø APR"
                content={CDP_AVERAGE_APR_INFO}
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Run/yr"
                content={CDP_BORROWING_HEADER_INFO.runRate}
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Upfront"
                content={CDP_BORROWING_HEADER_INFO.upfront}
                tooltipAlign="right"
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="Interest"
                content={CDP_BORROWING_HEADER_INFO.interest}
                tooltipAlign="right"
              />
            </Th>
            <Th align="right" className="sm:!px-2">
              <CdpBorrowingHeaderInfo
                label="All-time"
                content={CDP_BORROWING_HEADER_INFO.total}
                tooltipAlign="right"
              />
            </Th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => (
            <CdpBorrowingFeesMarketRow
              key={market.collateralId}
              market={market}
            />
          ))}
        </tbody>
      </Table>
    </section>
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
