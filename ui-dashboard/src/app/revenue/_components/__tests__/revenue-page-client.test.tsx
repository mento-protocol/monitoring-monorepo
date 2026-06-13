import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
  CdpBorrowingRevenueSummary,
} from "@/lib/cdp-borrowing-revenue";
import type {
  CanonicalRevenueDailyPoint,
  SusdsYieldDailySnapshotRow,
} from "@/lib/canonical-revenue";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import type { PoolDailyFeeSnapshot } from "@/lib/types";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import { makeNetworkData } from "@/test-utils/network-fixtures";

type TotalRevenueChartProps = {
  series: CanonicalRevenueDailyPoint[];
  isLoading: boolean;
  partialReasons: string[];
};

type RevenueTableProps = {
  hasError: boolean;
};

const mockUseProtocolFees = vi.hoisted(() => vi.fn());
const mockUseCdpBorrowingRevenue = vi.hoisted(() => vi.fn());
const mockUseReserveYield = vi.hoisted(() => vi.fn());
const mockUseReserveYieldHistory = vi.hoisted(() => vi.fn());
const capturedProps = vi.hoisted(() => ({
  chart: null as TotalRevenueChartProps | null,
  table: null as RevenueTableProps | null,
}));

const DAY = 86_400;

function ts(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 1000;
}

function currentDayTimestamp(): number {
  return Math.floor(Date.now() / 1000 / DAY) * DAY;
}

function usdWei(usd: number): string {
  return (BigInt(usd) * BigInt("1000000000000000000")).toString();
}

function feeSnapshot(timestamp: number, usd: number): PoolDailyFeeSnapshot {
  return {
    id: `fee-${timestamp}-${usd}`,
    chainId: 42220,
    poolAddress: "0xpool",
    timestamp: String(timestamp),
    tokens: [],
    tokenSymbols: [],
    tokenDecimals: [],
    amounts: [],
    feesUsdWei: usdWei(usd),
  };
}

function cdpPoint(
  timestamp: number,
  totalFeesUSD: number,
): CdpBorrowingFeeSeriesPoint {
  return {
    timestamp,
    upfrontFeesUSD: totalFeesUSD,
    accruedInterestUSD: 0,
    totalFeesUSD,
    collectedUSD: 0,
  };
}

function reserveSnapshot(
  timestamp: number,
  dailyEarnedYieldUsd: number,
): SusdsYieldDailySnapshotRow {
  return {
    id: `1-susds-${timestamp}`,
    chainId: 1,
    token: "0xsusds",
    timestamp: String(timestamp),
    currentShares: "0",
    costBasisUsdWei: "0",
    realizedYieldUsdWei: "0",
    transferredOutYieldUsdWei: "0",
    redeemedYieldUsdWei: "0",
    currentValueUsdWei: "0",
    unrealizedYieldUsdWei: "0",
    totalEarnedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    dailyEarnedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    dailyRealizedYieldUsdWei: "0",
    dailyUnrealizedYieldUsdWei: usdWei(dailyEarnedYieldUsd),
    sharePriceUsdWei: "1000000000000000000",
    sampledAtBlock: "1",
    sampledAtTimestamp: String(timestamp),
  };
}

const EMPTY_CDP_REVENUE: CdpBorrowingRevenueSummary = {
  totalRevenueUSD: 0,
  upfrontFeesUSD: 0,
  accruedInterestUSD: 0,
  protocolShareUSD: 0,
  spYieldShareUSD: 0,
  collectedUSD: 0,
  receivableUSD: 0,
  marketCount: 0,
  activeInterestBracketCount: 0,
  unpricedSymbols: [],
  bracketsTruncated: false,
};

const RESERVE_YIELD: ReserveYieldResponse = {
  principalUsd: 4_700,
  forecastPrincipalUsd: 4_700,
  earnedYieldUsd: 439.4,
  realizedYieldUsd: 275.58,
  unrealizedYieldUsd: 163.82,
  earnedYieldAsOf: "2026-06-03T10:41:11.000Z",
  holdings: [
    {
      id: "susds:ethereum:wallet:0xreserve:cold:0",
      assetSymbol: "sUSDS",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Reserve Safe",
      identifier: "0xreserve",
      custodianType: "cold",
      balance: 2_000,
      principalUsd: 2_200,
      earnedYieldUsd: 205.68,
      apyPercent: 3.6,
      yieldModel: "Sky Savings Rate APY from on-chain sUSDS.ssr()",
      dailyRunRateUsd: 79.2 / 365,
      next30dUsd: (79.2 * 30) / 365,
      next365dUsd: 79.2,
      annualRunRateUsd: 79.2,
    },
    {
      id: "AUSD:ethereum:wallet:0xops:ops:0",
      assetSymbol: "AUSD",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Ops Safe",
      identifier: "0xops",
      custodianType: "ops",
      balance: 1_500,
      principalUsd: 1_500,
      earnedYieldUsd: null,
      apyPercent: 2.784,
      yieldModel:
        "FEDFUNDS minus 15 bps expenses, then 80% Mento revenue share",
      dailyRunRateUsd: 41.76 / 365,
      next30dUsd: (41.76 * 30) / 365,
      next365dUsd: 41.76,
      annualRunRateUsd: 41.76,
    },
  ],
  holdingsAsOf: "2026-06-11T12:00:00.000Z",
  grossApyPercent: 3.63,
  fedfundsAsOf: "2026-06-01",
  expenseBps: 15,
  revenueShareBps: 8000,
  netMentoApyPercent: 2.784,
  skySavingsRateApyPercent: 3.6,
  skySavingsRateSource: "onchain-susds-ssr",
  dailyRunRateUsd: 10,
  next30dUsd: 300,
  next365dUsd: 3_650,
  annualRunRateUsd: 3_650,
  forecastUnavailableSymbols: [],
  holdingsError: null,
  rateError: null,
  earnedYieldError: null,
};

function cdpMarket(
  symbol: string,
  overrides: Partial<CdpBorrowingRevenueMarket> = {},
): CdpBorrowingRevenueMarket {
  return {
    collateralId: `42220-${symbol.toLowerCase()}`,
    chainId: 42220,
    collIndex: 0,
    symbol,
    spYieldSplitBps: 7500,
    activeDebtUSD: 900,
    averageAnnualInterestRatePercent: 6.25,
    annualInterestRunRateUSD: 312.5,
    activeTroveCount: 3,
    totalRevenueUSD: 187.5,
    upfrontFeesUSD: 125,
    accruedInterestUSD: 62.5,
    protocolShareUSD: 46.875,
    collectedUSD: 0,
    activeInterestBracketCount: 1,
    unpricedSymbols: [],
    bracketsTruncated: false,
    ...overrides,
  };
}

vi.mock("@/hooks/use-protocol-fees", () => ({
  useProtocolFees: () => mockUseProtocolFees(),
}));

vi.mock("@/hooks/use-cdp-borrowing-revenue", () => ({
  useCdpBorrowingRevenue: () => mockUseCdpBorrowingRevenue(),
}));

vi.mock("@/hooks/use-reserve-yield", () => ({
  useReserveYield: () => mockUseReserveYield(),
}));

vi.mock("@/hooks/use-reserve-yield-history", () => ({
  useReserveYieldHistory: () => mockUseReserveYieldHistory(),
}));

vi.mock("@/components/fee-over-time-chart", () => ({
  TotalRevenueChart: (props: TotalRevenueChartProps) => {
    capturedProps.chart = props;
    return (
      <section aria-label="Total Revenue chart">Total Revenue chart</section>
    );
  },
}));

vi.mock("@/components/revenue-by-pool-table", () => ({
  RevenueByPoolTable: (props: RevenueTableProps) => {
    capturedProps.table = props;
    return <div data-table-error={String(props.hasError)}>Swap table</div>;
  },
}));

import { RevenuePageClient } from "../revenue-page-client";

function renderRevenue({
  networkData = [],
  cdpRevenue = {},
  reserveYield = RESERVE_YIELD,
  reserveRows = [],
  reserveHistoryUnavailable = false,
  protocolFeesLoading = false,
  reserveYieldLoading = false,
  reserveYieldError = false,
  reserveHistoryLoading = false,
}: {
  networkData?: NetworkData[];
  cdpRevenue?: Partial<{
    summary: CdpBorrowingRevenueSummary | null;
    markets: CdpBorrowingRevenueMarket[];
    dailySeries: CdpBorrowingFeeSeriesPoint[];
    dailySeriesTruncated: boolean;
    dailySeriesApproximate: boolean;
    dailySeriesFailed: boolean;
    isLoading: boolean;
    hasError: boolean;
  }>;
  reserveYield?: ReserveYieldResponse | null;
  reserveRows?: SusdsYieldDailySnapshotRow[];
  reserveHistoryUnavailable?: boolean;
  protocolFeesLoading?: boolean;
  reserveYieldLoading?: boolean;
  reserveYieldError?: boolean;
  reserveHistoryLoading?: boolean;
} = {}) {
  mockUseProtocolFees.mockReturnValue({
    networkData,
    isLoading: protocolFeesLoading,
  });
  mockUseCdpBorrowingRevenue.mockReturnValue({
    summary: EMPTY_CDP_REVENUE,
    markets: [],
    dailySeries: [],
    dailySeriesTruncated: false,
    dailySeriesApproximate: false,
    dailySeriesFailed: false,
    isLoading: false,
    hasError: false,
    ...cdpRevenue,
  });
  mockUseReserveYield.mockReturnValue({
    data: reserveYield,
    isLoading: reserveYieldLoading,
    hasError: reserveYieldError,
  });
  mockUseReserveYieldHistory.mockReturnValue({
    rows: reserveRows,
    isLoading: reserveHistoryLoading,
    hasError: false,
    unavailable: reserveHistoryUnavailable,
    truncated: false,
  });
  return renderToStaticMarkup(<RevenuePageClient />);
}

function streamCardHtml(
  html: string,
  title: "Reserve Yield" | "Swap Fees" | "CDP Borrowing Revenue",
): string {
  const sectionStart = html.indexOf('aria-label="Revenue streams"');
  const sectionEnd = html.indexOf('aria-label="Total Revenue chart"');
  const streamSection = html.slice(sectionStart, sectionEnd);
  const cardStart = streamSection.indexOf(title);
  const nextTitle =
    title === "Reserve Yield"
      ? "Swap Fees"
      : title === "Swap Fees"
        ? "CDP Borrowing Revenue"
        : "</section>";
  const cardEnd = streamSection.indexOf(nextTitle, cardStart + title.length);
  return streamSection.slice(cardStart, cardEnd === -1 ? undefined : cardEnd);
}

function periodCardHtml(
  html: string,
  title: "Total Revenue" | "Last 30 Days" | "Last 7 Days",
): string {
  const sectionStart = html.indexOf('aria-label="Revenue actuals by period"');
  const sectionEnd = html.indexOf('aria-label="Revenue forecasts"');
  const periodSection = html.slice(sectionStart, sectionEnd);
  const cardStart = periodSection.indexOf(title);
  const nextTitle =
    title === "Total Revenue"
      ? "Last 30 Days"
      : title === "Last 30 Days"
        ? "Last 7 Days"
        : "</section>";
  const cardEnd = periodSection.indexOf(nextTitle, cardStart + title.length);
  return periodSection.slice(cardStart, cardEnd === -1 ? undefined : cardEnd);
}

describe("RevenuePageClient canonical revenue layout", () => {
  beforeEach(() => {
    mockUseProtocolFees.mockReset();
    mockUseCdpBorrowingRevenue.mockReset();
    mockUseReserveYield.mockReset();
    mockUseReserveYieldHistory.mockReset();
    capturedProps.chart = null;
    capturedProps.table = null;
  });

  it("renders canonical period cards, forecast cards, stream cards, and tables", () => {
    const completedDays = Array.from(
      { length: 30 },
      (_, index) => ts("2026-05-13") + index * DAY,
    );
    const html = renderRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: completedDays.map((timestamp) =>
            feeSnapshot(timestamp, 10),
          ),
          fees: {
            totalFeesUSD: 300,
            fees24hUSD: 10,
            fees7dUSD: 70,
            fees30dUSD: 300,
            unpricedSymbols: [],
            unpricedSymbols24h: [],
            unresolvedCount: 0,
            unresolvedCount24h: 0,
          },
        }),
      ],
      cdpRevenue: {
        markets: [cdpMarket("GBPm")],
        dailySeries: completedDays.map((timestamp) => cdpPoint(timestamp, 3)),
      },
      reserveRows: [reserveSnapshot(currentDayTimestamp(), 45)],
    });

    expect(html).toContain("Canonical revenue actuals since Mar 3, 2026");
    expect(html).toContain("Total Revenue");
    expect(html).toContain("Since Mar 3, 2026");
    expect(html).not.toContain("Year To Date");
    expect(html).toContain("Last 30 Days");
    expect(html).toContain("Rolling UTC daily buckets");
    expect(html).toContain("7d Forecast");
    expect(html).toContain("Monthly Forecast");
    expect(html).toContain("Annual Forecast");
    expect(html).toContain("Next 365 days");
    expect(html.indexOf("Annual Forecast")).toBeLessThan(
      html.indexOf("Monthly Forecast"),
    );
    expect(html.indexOf("Monthly Forecast")).toBeLessThan(
      html.indexOf("7d Forecast"),
    );
    expect(html).toContain("AUSD is forecast-only until a payout ledger");
    expect(html).toContain("Revenue streams");
    expect(html).toContain("sUSDS actual yield; AUSD forecast-only");
    expect(html).toContain("Reserve Yield Components");
    expect(html).toContain("Borrowing Fees by CDP");
    expect(html).toContain(
      "Split: 25% protocol treasury, 75% Stability Pool depositor yield.",
    );
    expect(
      capturedProps.chart?.series.some((p) => p.reserveYieldUsd === 45),
    ).toBe(true);
    expect(capturedProps.table).toMatchObject({ hasError: false });
  });

  it("shows neutral loading placeholders for period and forecast breakdown pills", () => {
    const html = renderRevenue({
      protocolFeesLoading: true,
      cdpRevenue: { isLoading: true },
      reserveYieldLoading: true,
      reserveHistoryLoading: true,
      reserveYield: null,
    });

    const cardSections = html.slice(
      0,
      html.indexOf('aria-label="Revenue streams"'),
    );
    expect(html).toContain("animate-pulse");
    expect(cardSections).not.toContain("$0.00");
  });

  it("propagates approximate actual reasons to period and stream cards", () => {
    const html = renderRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
          fees: {
            totalFeesUSD: 12,
            fees24hUSD: 12,
            fees7dUSD: 12,
            fees30dUSD: 12,
            unpricedSymbols: ["UNKNOWN"],
            unpricedSymbols24h: ["UNKNOWN"],
            unresolvedCount: 0,
            unresolvedCount24h: 0,
          },
        }),
      ],
    });

    expect(html).toContain("About Total Revenue partial data");
    expect(html).toContain("About Swap Fees partial data");
    expect(html).toContain("Swap fee history is approximate.");
    expect(streamCardHtml(html, "Swap Fees")).toContain("≈ $12.00");
    expect(capturedProps.chart?.partialReasons).toContain(
      "Swap fee history is approximate.",
    );
  });

  it("propagates forecast partial reasons to stream cards", () => {
    const html = renderRevenue({
      reserveYield: {
        ...RESERVE_YIELD,
        forecastUnavailableSymbols: ["AUSD"],
      },
      reserveRows: [reserveSnapshot(currentDayTimestamp(), 45)],
    });

    expect(html).toContain("About Reserve Yield partial data");
    expect(html).toContain(
      "Reserve forecast excludes holdings without APY sources: AUSD.",
    );
    expect(streamCardHtml(html, "Reserve Yield")).toContain("$45.00");
    expect(streamCardHtml(html, "Reserve Yield")).not.toContain("≈ $45.00");
  });

  it("flags reserve history missing as partial and does not inject current earned-yield API totals into chart actuals", () => {
    const html = renderRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      reserveYield: {
        ...RESERVE_YIELD,
        earnedYieldUsd: 999,
      },
      reserveRows: [],
      reserveHistoryUnavailable: true,
    });

    expect(html).toContain("Reserve earned-yield history is not indexed yet.");
    expect(capturedProps.chart?.partialReasons).toContain(
      "Reserve earned-yield history is not indexed yet.",
    );
    const reserveActual = capturedProps.chart?.series.reduce(
      (sum, point) => sum + (point.reserveYieldUsd ?? 0),
      0,
    );
    expect(reserveActual).toBe(0);
  });

  it("shows available actual revenue in period headlines when reserve history is stale", () => {
    const html = renderRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      reserveRows: [reserveSnapshot(ts("2026-06-03"), 5)],
    });

    expect(html).toContain(
      "Reserve earned-yield history is stale; latest snapshot is Jun 3, 2026.",
    );
    expect(periodCardHtml(html, "Total Revenue")).toContain("≈ $17.00");
    expect(periodCardHtml(html, "Total Revenue")).toContain("N/A");
    expect(streamCardHtml(html, "Reserve Yield")).toContain("N/A");
  });

  it("renders reserve actuals as N/A when reserve yield fails before snapshots exist", () => {
    const html = renderRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      reserveYield: null,
      reserveRows: [],
      reserveYieldError: true,
    });

    expect(html).toContain(
      "Reserve earned-yield actuals unavailable: current reserve yield failed to load before any snapshots were indexed.",
    );
    expect(streamCardHtml(html, "Reserve Yield")).toContain("N/A");
    expect(
      capturedProps.chart?.series.some((p) => p.reserveYieldUsd === null),
    ).toBe(true);
  });

  it("renders unavailable CDP actuals as N/A when daily history fails", () => {
    const html = renderRevenue({
      networkData: [
        makeNetworkData({
          feeSnapshots: [feeSnapshot(ts("2026-06-12"), 12)],
        }),
      ],
      cdpRevenue: {
        markets: [cdpMarket("GBPm")],
        dailySeries: [],
        dailySeriesFailed: true,
      },
      reserveRows: [reserveSnapshot(currentDayTimestamp(), 5)],
    });

    expect(html).toContain("CDP borrowing revenue history failed to load.");
    expect(streamCardHtml(html, "CDP Borrowing Revenue")).toContain("N/A");
    expect(
      capturedProps.chart?.series.some((p) => p.cdpBorrowingUsd === null),
    ).toBe(true);
  });

  it("passes fee failures through to the swap table and chart partial state", () => {
    renderRevenue({
      networkData: [
        makeNetworkData({
          ratesError: new Error("rates timeout"),
          fees: null,
        }),
      ],
    });

    expect(capturedProps.table).toMatchObject({ hasError: true });
    expect(capturedProps.chart?.partialReasons).toContain(
      "Swap fee history failed to load.",
    );
  });
});
