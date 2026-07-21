import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StableSupplyDailySnapshot } from "../../_lib/types";

const mockTimeSeriesChartCard = vi.hoisted(() => vi.fn());

vi.mock("@/components/time-series-chart-card", () => ({
  TimeSeriesChartCard: (props: unknown) => {
    mockTimeSeriesChartCard(props);
    return null;
  },
}));

import { StablesHeroChart } from "../stables-hero-chart";

describe("StablesHeroChart — chain labels", () => {
  it("uses the canonical Polygon label for chain 137 breakdowns", () => {
    const today = Math.floor(Date.now() / 86_400_000) * 86_400;
    const snapshot: StableSupplyDailySnapshot = {
      id: `137-0xstable-${today}`,
      chainId: 137,
      tokenAddress: "0xstable",
      tokenSymbol: "USDm",
      source: "RESERVE",
      tokenDecimals: 18,
      timestamp: String(today),
      totalSupply: "100000000000000000000",
      dailyMintAmount: "0",
      dailyBurnAmount: "0",
    };

    renderToStaticMarkup(
      <StablesHeroChart
        snapshots={[snapshot]}
        latestPerToken={[snapshot]}
        custodySnapshots={[]}
        latestCustodyPerToken={[]}
        rates={new Map([["USDm", 1]])}
        range="all"
        onRangeChange={() => undefined}
        isLoading={false}
        hasError={false}
      />,
    );

    const props = mockTimeSeriesChartCard.mock.calls.at(-1)?.[0] as
      | { breakdown: ReadonlyArray<{ name: string }> }
      | undefined;
    expect(props?.breakdown.map((series) => series.name)).toEqual([
      "USDm on Polygon",
    ]);
  });
});
