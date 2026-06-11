import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type {
  CdpBorrowingFeeSeriesPoint,
  CdpBorrowingRevenueMarket,
  CdpBorrowingRevenueSummary,
} from "@/lib/cdp-borrowing-revenue";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
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
const mockUseReserveYield = vi.hoisted(() => vi.fn());
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

const EMPTY_RESERVE_YIELD: ReserveYieldResponse = {
  principalUsd: 0,
  forecastPrincipalUsd: null,
  earnedYieldUsd: null,
  holdings: [],
  holdingsAsOf: "2026-06-11T12:00:00.000Z",
  grossApyPercent: 5.33,
  fedfundsAsOf: "2026-05-01",
  expenseBps: 15,
  revenueShareBps: 8000,
  netMentoApyPercent: 4.144,
  skySavingsRateApyPercent: 3.6,
  dailyRunRateUsd: 0,
  next30dUsd: 0,
  next365dUsd: 0,
  annualRunRateUsd: 0,
  forecastUnavailableSymbols: [],
  holdingsError: null,
  rateError: null,
};

const RESERVE_YIELD_WITH_HOLDINGS: ReserveYieldResponse = {
  ...EMPTY_RESERVE_YIELD,
  principalUsd: 4700,
  forecastPrincipalUsd: 4700,
  dailyRunRateUsd: 182.8 / 365,
  next30dUsd: (182.8 * 30) / 365,
  next365dUsd: 182.8,
  annualRunRateUsd: 182.8,
  forecastUnavailableSymbols: [],
  holdings: [
    {
      id: "susds:ethereum:wallet:0xreserve:cold:0",
      assetSymbol: "sUSDS",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Reserve Safe",
      identifier: "0xreserve",
      custodianType: "cold",
      balance: 2000,
      principalUsd: 2200,
      earnedYieldUsd: null,
      apyPercent: 3.6,
      yieldModel: "Sky Savings Rate APY from Block Analitica",
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
      balance: 1500,
      principalUsd: 1500,
      earnedYieldUsd: null,
      apyPercent: 4.144,
      yieldModel:
        "FEDFUNDS minus 15 bps expenses, then 80% Mento revenue share",
      dailyRunRateUsd: 0.1703013698630137,
      next30dUsd: 5.109041095890411,
      next365dUsd: 62.16,
      annualRunRateUsd: 62.16,
    },
    {
      id: "AUSD:monad:fpmm:0xfpmm:ops:0",
      assetSymbol: "AUSD",
      chain: "monad",
      sourceType: "fpmm",
      sourceLabel: "FPMM AUSD / USDm",
      identifier: "0xfpmm",
      custodianType: "ops",
      balance: 1000,
      principalUsd: 1000,
      earnedYieldUsd: null,
      apyPercent: 4.144,
      yieldModel:
        "FEDFUNDS minus 15 bps expenses, then 80% Mento revenue share",
      dailyRunRateUsd: 41.44 / 365,
      next30dUsd: (41.44 * 30) / 365,
      next365dUsd: 41.44,
      annualRunRateUsd: 41.44,
    },
  ],
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
    spYieldSplitBps: 7500,
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

vi.mock("@/hooks/use-reserve-yield", () => ({
  useReserveYield: () => mockUseReserveYield(),
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
  reserveYield: {
    data: ReserveYieldResponse | null;
    isLoading: boolean;
    hasError: boolean;
  } = {
    data: EMPTY_RESERVE_YIELD,
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
  mockUseReserveYield.mockReturnValue(reserveYield);
  return renderToStaticMarkup(<RevenuePageClient />);
}

describe("RevenuePageClient degraded fee states", () => {
  beforeEach(() => {
    mockUseProtocolFees.mockReset();
    mockUseCdpBorrowingRevenue.mockReset();
    mockUseReserveYield.mockReset();
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
    expect(html).toContain("$181.87");
    expect(html).toContain("Stability Pool Share");
    // Headline deep-links to the feeRecipient's DeBank profile, like the
    // Swap Fees tile.
    expect(html).toContain('aria-label="CDP Borrowing Fees: $60.63"');
    expect(html.match(/debank\.com\/profile\/0x0dd57f6f/gi)?.length).toBe(2);
    // All-time tooltip states the live on-chain split (7500 bps fixture).
    expect(html).toContain(
      "Split: 25% protocol treasury, 75% Stability Pool depositor yield.",
    );
    // Collected/receivable stay indexed but are no longer rendered — the
    // fixture's collectedUSD (30) / receivableUSD (30.63) must not appear.
    expect(html).not.toContain("Accruing");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("$30.00");
    expect(html).not.toContain("$30.63");
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
    expect(html).toContain("No yield-bearing reserve holdings returned");
    expect(capturedProps.chart).toMatchObject({
      isBorrowingFeesApproximate: false,
    });
  });

  it("renders reserve yield earned headline, forecasts, and component table", () => {
    const html = renderRevenue([], false, undefined, {
      data: RESERVE_YIELD_WITH_HOLDINGS,
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain("Reserve Yield");
    expect(html).toContain("N/A");
    expect(html).toContain("earned");
    expect(html).toContain("$15.02");
    expect(html).toContain("per month");
    expect(html).toContain("$182.80");
    expect(html).toContain("per year");
    expect(html).toContain("$4.7K");
    expect(html).toContain("reserve assets earning yield");
    expect(html).toContain('aria-label="About Reserve Yield forecast"');
    expect(html).toContain("Annual Forecast based on blended APY");
    expect(html).not.toContain("- Based on blended APY");
    expect(html).toContain("current Fed Funds Rate");
    expect(html).toContain("sUSDS APY uses the Sky Savings Rate");
    expect(html).toContain("Block Analitica");
    expect(html).toContain("balance x APY x days / 365");
    expect(html).not.toContain("sUSDS currently excluded");
    expect(html).toContain("Reserve Yield Components");
    expect(html).toContain("Balance");
    expect(html).toContain("APY");
    expect(html).toContain("3.6%");
    expect(html).toContain("sUSDS");
    expect(html).toContain("AUSD");
    expect(html).toContain("Ethereum");
    expect(html).toContain("Monad");
    expect(html).toContain("Reserve Safe");
    expect(html).toContain("Ops Safe");
    expect(html).toContain("wallet / ops");
    expect(html).toContain("FPMM AUSD / USDm");
    expect(html).toContain('aria-label="Reserve yield components"');
  });

  it("shows reserve yield loading state before the route resolves", () => {
    const html = renderRevenue([], false, undefined, {
      data: null,
      isLoading: true,
      hasError: false,
    });

    expect(html).toContain("Reserve Yield");
    expect(html).toContain("Loading reserve yield");
    expect(html).toContain("Reserve Yield Components");
    expect(html).toContain("Loading…");
  });

  it("keeps AUSD balance visible when FEDFUNDS is unavailable", () => {
    const html = renderRevenue([], false, undefined, {
      data: {
        ...RESERVE_YIELD_WITH_HOLDINGS,
        grossApyPercent: null,
        fedfundsAsOf: null,
        netMentoApyPercent: null,
        skySavingsRateApyPercent: null,
        forecastPrincipalUsd: null,
        dailyRunRateUsd: null,
        next30dUsd: null,
        next365dUsd: null,
        annualRunRateUsd: null,
        forecastUnavailableSymbols: ["AUSD", "SUSDS"],
        holdings: RESERVE_YIELD_WITH_HOLDINGS.holdings.map((holding) => ({
          ...holding,
          apyPercent: null,
          dailyRunRateUsd: null,
          next30dUsd: null,
          next365dUsd: null,
          annualRunRateUsd: null,
        })),
        rateError: "FRED FEDFUNDS: HTTP 503",
      },
      isLoading: false,
      hasError: true,
    });

    expect(html).toContain("forecast rates unavailable");
    expect(html).toContain("$4.7K");
    expect(html).toContain("Forecast rates are unavailable");
    expect(html).not.toContain("Some forecast rates are unavailable");
    expect(html).toContain("showing balances without forecast");
    expect(html).toContain("N/A");
  });

  it("does not pass reserve-yield forecasts into the Total Fees chart", () => {
    renderRevenue([], false, undefined, {
      data: RESERVE_YIELD_WITH_HOLDINGS,
      isLoading: false,
      hasError: false,
    });

    expect(capturedProps.chart).not.toBeNull();
    expect(Object.keys(capturedProps.chart ?? {})).not.toContain(
      "reserveYield",
    );
    expect(capturedProps.chart).toMatchObject({
      borrowingFeeSeries: [],
      hasBorrowingFeesError: false,
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

describe("cdpBorrowingTotalTooltip fallback via RevenuePageClient", () => {
  beforeEach(() => {
    mockUseProtocolFees.mockReset();
    mockUseCdpBorrowingRevenue.mockReset();
  });

  it("falls back to generic split wording when market splits disagree", () => {
    const gbp = cdpMarket("GBPm", 187.5, 125, 62.5);
    const chf = { ...cdpMarket("CHFm", 55, 55, 0), spYieldSplitBps: 5000 };
    const html = renderRevenue([], false, {
      summary: EMPTY_CDP_REVENUE,
      markets: [gbp, chf],
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain(
      "The protocol keeps the share shown in the summary tile",
    );
    expect(html).not.toContain("% protocol treasury");
  });

  it("falls back to generic split wording on the unloaded -1 sentinel", () => {
    const gbp = { ...cdpMarket("GBPm", 187.5, 125, 62.5), spYieldSplitBps: -1 };
    const html = renderRevenue([], false, {
      summary: EMPTY_CDP_REVENUE,
      markets: [gbp],
      isLoading: false,
      hasError: false,
    });

    expect(html).toContain(
      "The protocol keeps the share shown in the summary tile",
    );
    expect(html).not.toContain("% protocol treasury");
  });
});
