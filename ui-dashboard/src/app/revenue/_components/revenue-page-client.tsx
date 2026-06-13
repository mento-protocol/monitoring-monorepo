"use client";

import { Suspense, useMemo, type ReactNode } from "react";
import { formatUSD } from "@/lib/format";
import type { NetworkData } from "@/lib/fetch-all-networks";
import { useCdpBorrowingRevenue } from "@/hooks/use-cdp-borrowing-revenue";
import type { CdpBorrowingRevenueMarket } from "@/lib/cdp-borrowing-revenue";
import { useReserveYield } from "@/hooks/use-reserve-yield";
import { useReserveYieldHistory } from "@/hooks/use-reserve-yield-history";
import { useCanonicalRevenue } from "@/hooks/use-canonical-revenue";
import { useProtocolFees } from "@/hooks/use-protocol-fees";
import { TotalRevenueChart } from "@/components/fee-over-time-chart";
import { ReserveYieldByHoldingTable } from "./reserve-yield-components";
import { Tooltip } from "@/components/tooltip";
import { RevenueByPoolTable } from "@/components/revenue-by-pool-table";
import { Row, Table, Td, Th } from "@/components/table";
import type {
  CanonicalRevenueForecast,
  CanonicalRevenuePeriod,
  CanonicalRevenueStream,
  RevenueForecastKey,
  RevenuePeriodKey,
} from "@/lib/canonical-revenue";
import { V3_REVENUE_LAUNCH_LABEL } from "@/lib/canonical-revenue";

// Table fee columns are GROSS (borrower-side fees, before the SP yield
// split); the summary tile headlines the protocol's share. Tooltips call
// this out so the two surfaces don't read as contradictory.
const CDP_BORROWING_HEADER_INFO = {
  debt: "Active CDP debt, priced to USD from the debt token's live oracle rate.",
  runRate:
    "Annualized gross interest if current debt and rates stay unchanged, before the SP yield split.",
  upfront:
    "Cumulative one-time borrowing fees paid when troves are opened or debt is increased (gross, before the SP yield split).",
  interest:
    "Accrued interest so far, including live accrual since the last indexer update (gross, before the SP yield split).",
} as const;

const bpsToPercentLabel = (bps: number): string => {
  const pct = bps / 100;
  return Number.isInteger(pct)
    ? String(pct)
    : String(Math.round(pct * 100) / 100);
};

function hasApproximateCdpForecastInputs(args: {
  dailySeriesApproximate: boolean;
  dailySeriesTruncated: boolean;
  dailySeriesFailed: boolean;
  hasRevenueError: boolean;
  unpricedSymbolCount: number;
  bracketsTruncated: boolean;
}): boolean {
  if (args.hasRevenueError || args.dailySeriesFailed) return false;
  return (
    args.dailySeriesApproximate ||
    args.dailySeriesTruncated ||
    args.unpricedSymbolCount > 0 ||
    args.bracketsTruncated
  );
}

// The split is governance-set on-chain per market (SystemParams.SP_YIELD_SPLIT,
// indexed as LiquityCollateral.spYieldSplitBps and surfaced per market row),
// so the tooltip states the live values instead of hardcoding 25/75. Falls
// back to generic wording when markets disagree or the indexer hasn't loaded
// the param yet (-1 sentinel).
function cdpBorrowingTotalTooltip(
  markets: ReadonlyArray<CdpBorrowingRevenueMarket>,
): string {
  const splits = [...new Set(markets.map((m) => m.spYieldSplitBps))];
  const bps =
    splits.length === 1 &&
    splits[0] !== undefined &&
    splits[0] >= 0 &&
    splits[0] <= 10_000
      ? splits[0]
      : null;
  if (bps === null) {
    return "Gross borrowing fees (upfront + accrued interest), paid by borrowers. The protocol keeps the share shown in the summary tile; the rest is Stability Pool depositor yield.";
  }
  return `Gross borrowing fees (upfront + accrued interest), paid by borrowers. Split: ${bpsToPercentLabel(10_000 - bps)}% protocol treasury, ${bpsToPercentLabel(bps)}% Stability Pool depositor yield.`;
}

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
    dailySeriesApproximate: cdpBorrowingFeeSeriesApproximate,
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
    dailySeriesApproximate: cdpBorrowingFeeSeriesApproximate,
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
        periods={[
          canonicalRevenue.periods.allTimeSinceV3,
          canonicalRevenue.periods.last30d,
          canonicalRevenue.periods.last7d,
        ]}
        isLoading={isRevenueLoading}
        partialReasons={actualPartialReasons}
      />

      <ForecastCards
        forecasts={[
          canonicalRevenue.forecasts.next365d,
          canonicalRevenue.forecasts.next30d,
          canonicalRevenue.forecasts.next7d,
        ]}
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

const PERIOD_CARD_ORDER: RevenuePeriodKey[] = [
  "allTimeSinceV3",
  "last30d",
  "last7d",
];

const FORECAST_CARD_ORDER: RevenueForecastKey[] = [
  "next365d",
  "next30d",
  "next7d",
];

function LoadingValue() {
  return (
    <span className="inline-block h-[1em] w-28 animate-pulse rounded bg-slate-800/60 align-middle" />
  );
}

function LoadingPillValue() {
  return (
    <span className="inline-block h-[1em] w-12 animate-pulse rounded bg-slate-800/60 align-middle" />
  );
}

function mutedUnavailable(value: number | null): string {
  return value === null ? "N/A" : `≈ ${formatUSD(value)}`;
}

function formatActualValue(value: number | null, isPartial: boolean): string {
  if (value === null) return "N/A";
  return `${isPartial ? "≈ " : ""}${formatUSD(value)}`;
}

function PeriodCard({
  period,
  isLoading,
  partialReasons,
}: {
  period: CanonicalRevenuePeriod;
  isLoading: boolean;
  partialReasons: string[];
}) {
  const isPartial = partialReasons.length > 0;
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-300">{period.title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{period.subtitle}</p>
        </div>
        {isPartial ? (
          <Tooltip
            label={`About ${period.title} partial data`}
            content={partialReasons.join("\n")}
            align="right"
          />
        ) : null}
      </div>
      <p className="mt-3 font-mono text-2xl font-semibold text-white">
        {isLoading ? (
          <LoadingValue />
        ) : (
          formatActualValue(period.totalUsd, isPartial)
        )}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <MetricPill
          label="Reserve"
          value={period.reserveYieldUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="Swap"
          value={period.swapFeesUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="CDP"
          value={period.cdpBorrowingUsd}
          isLoading={isLoading}
        />
      </div>
    </article>
  );
}

function RevenuePeriodCards({
  periods,
  isLoading,
  partialReasons,
}: {
  periods: CanonicalRevenuePeriod[];
  isLoading: boolean;
  partialReasons: string[];
}) {
  const orderedPeriods: CanonicalRevenuePeriod[] = [];
  const periodByKey = new Map(periods.map((period) => [period.key, period]));
  for (const key of PERIOD_CARD_ORDER) {
    const period = periodByKey.get(key);
    if (period !== undefined) orderedPeriods.push(period);
  }

  return (
    <section
      aria-label="Revenue actuals by period"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {orderedPeriods.map((period) => (
        <PeriodCard
          key={period.key}
          period={period}
          isLoading={isLoading}
          partialReasons={partialReasons}
        />
      ))}
    </section>
  );
}

function MetricPill({
  label,
  value,
  isLoading,
}: {
  label: string;
  value: number | null;
  isLoading: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <p className="truncate text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-slate-200">
        {isLoading ? (
          <LoadingPillValue />
        ) : value === null ? (
          "N/A"
        ) : (
          formatUSD(value)
        )}
      </p>
    </div>
  );
}

function ForecastCard({
  forecast,
  isLoading,
}: {
  forecast: CanonicalRevenueForecast;
  isLoading: boolean;
}) {
  const isPartial = forecast.partialReasons.length > 0;
  const tooltip = [
    forecast.assumption,
    ...forecast.partialReasons.map((reason) => `- ${reason}`),
  ].join("\n");
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-300">
            {forecast.title}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">{forecast.subtitle}</p>
        </div>
        <Tooltip
          label={`About ${forecast.title}`}
          content={tooltip}
          align="right"
        />
      </div>
      <p className="mt-3 font-mono text-2xl font-semibold text-white">
        {isLoading ? <LoadingValue /> : mutedUnavailable(forecast.totalUsd)}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <MetricPill
          label="Reserve"
          value={forecast.reserveYieldUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="Swap"
          value={forecast.swapFeesUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="CDP"
          value={forecast.cdpBorrowingUsd}
          isLoading={isLoading}
        />
      </div>
      {isPartial ? (
        <p className="mt-2 text-xs text-slate-500">Partial forecast inputs</p>
      ) : null}
    </article>
  );
}

function ForecastCards({
  forecasts,
  isLoading,
}: {
  forecasts: CanonicalRevenueForecast[];
  isLoading: boolean;
}) {
  const orderedForecasts: CanonicalRevenueForecast[] = [];
  const forecastByKey = new Map(
    forecasts.map((forecast) => [forecast.key, forecast]),
  );
  for (const key of FORECAST_CARD_ORDER) {
    const forecast = forecastByKey.get(key);
    if (forecast !== undefined) orderedForecasts.push(forecast);
  }
  return (
    <section
      aria-label="Revenue forecasts"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {orderedForecasts.map((forecast) => (
        <ForecastCard
          key={forecast.key}
          forecast={forecast}
          isLoading={isLoading}
        />
      ))}
    </section>
  );
}

function RevenueStreamCards({
  streams,
  isLoading,
  actualPartialReasons,
}: {
  streams: CanonicalRevenueStream[];
  isLoading: boolean;
  actualPartialReasons: string[];
}) {
  return (
    <section
      aria-label="Revenue streams"
      className="grid grid-cols-1 gap-4 md:grid-cols-3"
    >
      {streams.map((stream) => {
        const streamActualPartialReasons = [
          ...new Set([
            ...stream.actualPartialReasons,
            ...partialReasonsForStream(stream.key, actualPartialReasons),
          ]),
        ];
        const partialReasons = [
          ...new Set([
            ...streamActualPartialReasons,
            ...stream.forecastPartialReasons,
          ]),
        ];
        return (
          <StreamCard
            key={stream.key}
            stream={stream}
            isLoading={isLoading}
            actualPartialReasons={streamActualPartialReasons}
            partialReasons={partialReasons}
          />
        );
      })}
    </section>
  );
}

function partialReasonsForStream(
  streamKey: CanonicalRevenueStream["key"],
  reasons: readonly string[],
): string[] {
  const needle =
    streamKey === "cdp" ? "cdp" : streamKey === "swap" ? "swap" : "reserve";
  return [
    ...new Set(
      reasons.filter((reason) => reason.toLowerCase().includes(needle)),
    ),
  ];
}

function StreamCard({
  stream,
  isLoading,
  actualPartialReasons,
  partialReasons,
}: {
  stream: CanonicalRevenueStream;
  isLoading: boolean;
  actualPartialReasons: string[];
  partialReasons: string[];
}) {
  const isPartial = partialReasons.length > 0;
  const actualIsPartial = actualPartialReasons.length > 0;
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-300">{stream.title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{stream.subtitle}</p>
        </div>
        {isPartial ? (
          <Tooltip
            label={`About ${stream.title} partial data`}
            content={partialReasons.join("\n")}
            align="right"
          />
        ) : null}
      </div>
      <p className="mt-3 font-mono text-xl font-semibold text-white">
        {isLoading ? (
          <LoadingValue />
        ) : (
          formatActualValue(stream.actualUsd, actualIsPartial)
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>30d {mutedUnavailable(stream.forecast30dUsd)}</span>
        <span>1y {mutedUnavailable(stream.forecast365dUsd)}</span>
      </div>
    </article>
  );
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
    <Tooltip label={`About ${label}`} content={content} align={tooltipAlign}>
      {label}
    </Tooltip>
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
                content={cdpBorrowingTotalTooltip(markets)}
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
