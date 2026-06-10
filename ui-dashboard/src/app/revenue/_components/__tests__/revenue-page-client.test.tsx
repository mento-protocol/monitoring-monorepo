import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
  CdpBorrowingRevenueSummary,
} from "@/lib/cdp-borrowing-revenue";
import { makeNetworkData } from "@/test-utils/network-fixtures";

type FeeChartProps = {
  borrowingFeeSeries: CdpBorrowingFeeSeriesPoint[];
  isBorrowingFeesLoading: boolean;
  hasError: boolean;
  hasFeesError: boolean;
  hasBorrowingFeesError: boolean;
  isApproximate: boolean;
  isBorrowingFeesApproximate: boolean;
};

type RevenueTableProps = {
  hasError: boolean;
};

const mockUseProtocolFees = vi.hoisted(() => vi.fn());
const mockUseCdpBorrowingRevenue = vi.hoisted(() => vi.fn());
const capturedProps = vi.hoisted(() => ({
  chart: null as FeeChartProps | null,
  table: null as RevenueTableProps | null,
}));

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

function cdpMarket(
  symbol: string,
  totalRevenueUSD: number,
  upfrontFeesUSD: number,
  accruedInterestUSD: number,
  activeDebtUSD = 900,
  averageAnnualInterestRatePercent: number | null = 6.25,
  annualInterestRunRateUSD = 312.5,
  activeTroveCount = 3,
): CdpBorrowingRevenueMarket {
  return {
    collateralId: `42220-${symbol.toLowerCase()}`,
    chainId: 42220,
    collIndex: 0,
    symbol,
    activeDebtUSD,
    averageAnnualInterestRatePercent,
    annualInterestRunRateUSD,
    activeTroveCount,
    totalRevenueUSD,
    upfrontFeesUSD,
    accruedInterestUSD,
    protocolShareUSD: totalRevenueUSD * 0.25,
    collectedUSD: 0,
    activeInterestBracketCount: 1,
    unpricedSymbols: [],
    bracketsTruncated: false,
  };
}

vi.mock("@/hooks/use-protocol-fees", () => ({
  useProtocolFees: () => mockUseProtocolFees(),
}));

vi.mock("@/hooks/use-cdp-borrowing-revenue", () => ({
  useCdpBorrowingRevenue: () => mockUseCdpBorrowingRevenue(),
}));

vi.mock("@/components/fee-over-time-chart", () => ({
  FeeOverTimeChart: (props: FeeChartProps) => {
    capturedProps.chart = props;
    return (
      <div
        data-fees-error={String(props.hasFeesError)}
        data-borrowing-fees-error={String(props.hasBorrowingFeesError)}
        data-approximate={String(props.isApproximate)}
        data-borrowing-approximate={String(props.isBorrowingFeesApproximate)}
      />
    );
  },
}));

vi.mock("@/components/revenue-by-pool-table", () => ({
  RevenueByPoolTable: (props: RevenueTableProps) => {
    capturedProps.table = props;
    return <div data-table-error={String(props.hasError)} />;
  },
}));

import { RevenuePageClient } from "../revenue-page-client";

function renderRevenue(
  networkData: NetworkData[],
  isLoading = false,
  cdpRevenue: {
    summary: CdpBorrowingRevenueSummary | null;
    markets?: CdpBorrowingRevenueMarket[];
    dailySeries?: CdpBorrowingFeeSeriesPoint[];
    dailySeriesTruncated?: boolean;
    dailySeriesApproximate?: boolean;
    dailySeriesFailed?: boolean;
    isLoading: boolean;
    hasError: boolean;
  } = {
    summary: EMPTY_CDP_REVENUE,
    markets: [],
    isLoading: false,
    hasError: false,
  },
) {
  mockUseProtocolFees.mockReturnValue({ networkData, isLoading });
  mockUseCdpBorrowingRevenue.mockReturnValue({
    markets: [],
    dailySeries: [],
    dailySeriesTruncated: false,
    dailySeriesApproximate: false,
    dailySeriesFailed: false,
    ...cdpRevenue,
  });
  return renderToStaticMarkup(<RevenuePageClient />);
}

describe("RevenuePageClient degraded fee states", () => {
  beforeEach(() => {
    mockUseProtocolFees.mockReset();
    mockUseCdpBorrowingRevenue.mockReset();
    capturedProps.chart = null;
    capturedProps.table = null;
  });

  it("fails fee surfaces closed when the protocol fee hook reports a fee error", () => {
    const html = renderRevenue([
      makeNetworkData({
        ratesError: new Error("rates timeout"),
        fees: null,
      }),
    ]);

    expect(html).toContain("N/A");
    expect(html).toContain("Some chains failed to load");
    expect(capturedProps.chart).toMatchObject({
      hasError: false,
      hasFeesError: true,
      hasBorrowingFeesError: false,
      isApproximate: false,
      isBorrowingFeesApproximate: false,
    });
    expect(capturedProps.table).toMatchObject({ hasError: true });
  });

  it("marks fees approximate when fee snapshot pagination is truncated", () => {
    const html = renderRevenue([
      makeNetworkData({
        feeSnapshotsTruncated: true,
        fees: {
          totalFeesUSD: 100,
          fees24hUSD: 10,
          fees7dUSD: 25,
          fees30dUSD: 50,
          unpricedSymbols: [],
          unpricedSymbols24h: [],
          unresolvedCount: 0,
          unresolvedCount24h: 0,
        },
      }),
    ]);

    expect(html).toContain("Approximate");
    expect(html).toContain("full history exceeds pagination cap");
    expect(capturedProps.chart).toMatchObject({
      hasError: false,
      hasFeesError: false,
      hasBorrowingFeesError: false,
      isApproximate: true,
      isBorrowingFeesApproximate: false,
    });
    expect(capturedProps.table).toMatchObject({ hasError: false });
  });

  it("renders CDP borrowing fees from real upfront and accrued interest data", () => {
    const html = renderRevenue([], false, {
      summary: {
        ...EMPTY_CDP_REVENUE,
        totalRevenueUSD: 242.5,
        upfrontFeesUSD: 180,
        accruedInterestUSD: 62.5,
        protocolShareUSD: 60.63,
        spYieldShareUSD: 181.87,
        collectedUSD: 30,
        receivableUSD: 30.63,
        marketCount: 2,
        activeInterestBracketCount: 1,
      },
      markets: [
        cdpMarket("GBPm", 187.5, 125, 62.5),
        cdpMarket("CHFm", 55, 55, 0),
      ],
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain("CDP Borrowing Fees");
    // Headline = protocol share (earned); one gross/SP-split context row.
    expect(html).toContain("$60.63");
    expect(html).toContain("earned");
    expect(html).toContain("Gross");
    expect(html).toContain("$242.50");
    expect(html).toContain("of which $181.87 goes to stability");
    // Collected/receivable stay indexed but are no longer rendered.
    expect(html).not.toContain("Accruing");
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain("Protocol share of borrowing fees");
    expect(html).toContain("Protocol share of swap fees");
    expect(html).toContain("Borrowing Fees by CDP");
    expect(html).toContain("Debt");
    expect(html).toContain("ø APR");
    expect(html).toContain("Run/yr");
    expect(html).toContain('aria-label="About ø APR"');
    expect(html).toContain('aria-label="About Run/yr"');
    expect(html).not.toContain(
      'title="Debt-weighted average APR across active debt',
    );
    expect(html).toContain("GBPm");
    expect(html).toContain("CHFm");
    expect(html).toContain("$900.00");
    expect(html).toContain("6.25%");
    expect(html).toContain("$312.50");
    expect(html).toContain("3 active troves");
    expect(html).toContain("$187.50");
    expect(html).not.toContain("Requires Liquity v2 indexing");
    expect(html).toContain("Reserve Yield");
    expect(html).toContain("Requires external data source integration");
    expect(capturedProps.chart).toMatchObject({
      isBorrowingFeesApproximate: false,
    });
  });

  it("marks CDP borrowing fees approximate when a debt token is unpriced", () => {
    const html = renderRevenue([], false, {
      summary: {
        ...EMPTY_CDP_REVENUE,
        totalRevenueUSD: 20,
        upfrontFeesUSD: 20,
        protocolShareUSD: 5,
        spYieldShareUSD: 15,
        unpricedSymbols: ["JPYm"],
      },
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain("≈ $5.00");
    expect(html).toContain("Approximate");
    expect(html).toContain("unpriced debt token: JPYm");
  });

  it("shows CDP borrowing fees as loading before the hook resolves", () => {
    const html = renderRevenue([], false, {
      summary: null,
      isLoading: true,
      hasError: false,
    });

    expect(html).toContain("CDP Borrowing Fees");
    expect(html).toContain("—");
    expect(html).toContain("Loading CDP borrowing fees");
    expect(html).not.toContain("Unable to load CDP borrowing fees");
  });

  it("marks CDP borrowing fees approximate when bracket pagination is capped", () => {
    const html = renderRevenue([], false, {
      summary: {
        ...EMPTY_CDP_REVENUE,
        totalRevenueUSD: 20,
        upfrontFeesUSD: 20,
        protocolShareUSD: 5,
        spYieldShareUSD: 15,
        bracketsTruncated: true,
      },
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain("≈ $5.00");
    expect(html).toContain("interest brackets exceed pagination cap");
  });

  it("marks the total fee chart approximate when borrowing fee history uses the fallback series", () => {
    renderRevenue([], false, {
      summary: {
        ...EMPTY_CDP_REVENUE,
        totalRevenueUSD: 20,
        accruedInterestUSD: 20,
      },
      dailySeriesApproximate: true,
      isLoading: false,
      hasError: false,
    });

    expect(capturedProps.chart).toMatchObject({
      isBorrowingFeesApproximate: true,
    });
  });

  it("marks the total fee chart partial when CDP borrowing fees fail", () => {
    const html = renderRevenue(
      [
        makeNetworkData({
          fees: {
            totalFeesUSD: 100,
            fees24hUSD: 10,
            fees7dUSD: 25,
            fees30dUSD: 50,
            unpricedSymbols: [],
            unpricedSymbols24h: [],
            unresolvedCount: 0,
            unresolvedCount24h: 0,
          },
        }),
      ],
      false,
      {
        summary: null,
        isLoading: false,
        hasError: true,
      },
    );

    expect(html).toContain("Unable to load CDP borrowing fees");
    expect(capturedProps.chart).toMatchObject({
      hasError: false,
      hasFeesError: false,
      hasBorrowingFeesError: true,
      isApproximate: false,
    });
    expect(capturedProps.table).toMatchObject({ hasError: false });
  });

  it("fails the total fee chart closed when only the borrowing daily series fails", () => {
    const html = renderRevenue([], false, {
      summary: {
        ...EMPTY_CDP_REVENUE,
        totalRevenueUSD: 20,
        accruedInterestUSD: 20,
      },
      dailySeriesFailed: true,
      isLoading: false,
      hasError: false,
    });

    // The chart fails closed (a swap-only total would misrepresent the missing
    // borrowing history) — and is NOT merely flagged approximate.
    expect(capturedProps.chart).toMatchObject({
      hasBorrowingFeesError: true,
      isBorrowingFeesApproximate: false,
    });
    // But the summary tiles keep the borrowing revenue already computed from
    // the (successful) market/bracket/rate queries.
    expect(html).not.toContain("Unable to load CDP borrowing fees");
    expect(html).toContain("$20.00");
  });
});
