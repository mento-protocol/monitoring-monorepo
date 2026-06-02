import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { CdpBorrowingRevenueSummary } from "@/lib/cdp-borrowing-revenue";
import { makeNetworkData } from "@/test-utils/network-fixtures";

type FeeChartProps = {
  hasError: boolean;
  hasFeesError: boolean;
  isApproximate: boolean;
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
  annualizedInterestUSD: 0,
  marketCount: 0,
  activeInterestBracketCount: 0,
  unpricedSymbols: [],
  bracketsTruncated: false,
};

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
        data-approximate={String(props.isApproximate)}
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
    isLoading: boolean;
    hasError: boolean;
  } = {
    summary: EMPTY_CDP_REVENUE,
    isLoading: false,
    hasError: false,
  },
) {
  mockUseProtocolFees.mockReturnValue({ networkData, isLoading });
  mockUseCdpBorrowingRevenue.mockReturnValue(cdpRevenue);
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
      isApproximate: false,
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
      isApproximate: true,
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
        annualizedInterestUSD: 125,
        marketCount: 2,
        activeInterestBracketCount: 1,
      },
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain("CDP Borrowing Fees");
    expect(html).toContain("$242.50");
    expect(html).toContain("Upfront");
    expect(html).toContain("$180.00");
    expect(html).toContain("Interest");
    expect(html).toContain("$62.50");
    expect(html).toContain(
      "Upfront fees plus accrued interest from Liquity v2",
    );
    expect(html).not.toContain("Requires Liquity v2 indexing");
    expect(html).toContain("Reserve Yield");
    expect(html).toContain("Requires external data source integration");
  });

  it("marks CDP borrowing fees approximate when a debt token is unpriced", () => {
    const html = renderRevenue([], false, {
      summary: {
        ...EMPTY_CDP_REVENUE,
        totalRevenueUSD: 20,
        upfrontFeesUSD: 20,
        unpricedSymbols: ["JPYm"],
      },
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain("≈ $20.00");
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
    expect(html).toContain("Loading CDP borrowing fees");
    expect(html).not.toContain("Unable to load CDP borrowing fees");
  });

  it("marks CDP borrowing fees approximate when bracket pagination is capped", () => {
    const html = renderRevenue([], false, {
      summary: {
        ...EMPTY_CDP_REVENUE,
        totalRevenueUSD: 20,
        upfrontFeesUSD: 20,
        bracketsTruncated: true,
      },
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain("≈ $20.00");
    expect(html).toContain("interest brackets exceed pagination cap");
  });

  it("isolates CDP borrowing fee failures from swap fee chart and table props", () => {
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
      isApproximate: false,
    });
    expect(capturedProps.table).toMatchObject({ hasError: false });
  });
});
