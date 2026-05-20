import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkData } from "@/hooks/use-all-networks-data";
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
const capturedProps = vi.hoisted(() => ({
  chart: null as FeeChartProps | null,
  table: null as RevenueTableProps | null,
}));

vi.mock("@/hooks/use-protocol-fees", () => ({
  useProtocolFees: () => mockUseProtocolFees(),
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

function renderRevenue(networkData: NetworkData[], isLoading = false) {
  mockUseProtocolFees.mockReturnValue({ networkData, isLoading });
  return renderToStaticMarkup(<RevenuePageClient />);
}

describe("RevenuePageClient degraded fee states", () => {
  beforeEach(() => {
    mockUseProtocolFees.mockReset();
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
});
