import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolSnapshot } from "@/lib/types";

const plotlyMock = vi.hoisted(() => {
  const capturedPlotProps: Array<{ data?: Array<{ y?: number[] }> }> = [];

  function MockPlot(props: { data?: Array<{ y?: number[] }> }) {
    capturedPlotProps.push(props);
    return null;
  }

  return { capturedPlotProps, MockPlot };
});

vi.mock("react-plotly.js", () => ({
  default: plotlyMock.MockPlot,
}));

vi.mock("next/dynamic", () => ({
  default: () => plotlyMock.MockPlot,
}));

import { LiquidityChart } from "@/components/liquidity-chart";

const BASE_POOL: Pool = {
  id: "42220-0x000000000000000000000000000000000000aaaa",
  chainId: 42220,
  token0: null,
  token1: null,
  source: "FPMM",
  createdAtBlock: "1",
  createdAtTimestamp: "1",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1",
  token0Decimals: 18,
  token1Decimals: 18,
  tokenDecimalsKnown: true,
};

function snapshot({
  reserves0,
  reserves1,
}: {
  reserves0: string;
  reserves1: string;
}): PoolSnapshot {
  return {
    id: "snap-1",
    poolId: BASE_POOL.id,
    timestamp: "1767225600",
    reserves0,
    reserves1,
    swapCount: 1,
    swapVolume0: "0",
    swapVolume1: "0",
    rebalanceCount: 0,
    cumulativeSwapCount: 1,
    cumulativeVolume0: "0",
    cumulativeVolume1: "0",
    blockNumber: "1",
  };
}

beforeEach(() => {
  plotlyMock.capturedPlotProps.length = 0;
});

describe("LiquidityChart", () => {
  it("plots overlapping USD reserve values for equivalent USDm-base and USDm-quote pools", () => {
    renderToStaticMarkup(
      <LiquidityChart
        snapshots={[
          snapshot({
            reserves0: "200000000000000000000",
            reserves1: "100000000000000000000",
          }),
        ]}
        pool={{
          ...BASE_POOL,
          oraclePrice: "2000000000000000000000000",
        }}
        token0Symbol="USDm"
        token1Symbol="TESTm"
      />,
    );

    renderToStaticMarkup(
      <LiquidityChart
        snapshots={[
          snapshot({
            reserves0: "100000000000000000000",
            reserves1: "200000000000000000000",
          }),
        ]}
        pool={{
          ...BASE_POOL,
          oraclePrice: "2000000000000000000000000",
        }}
        token0Symbol="TESTm"
        token1Symbol="USDm"
      />,
    );

    const [usdmBasePlot, usdmQuotePlot] = plotlyMock.capturedPlotProps;

    expect(usdmBasePlot?.data?.[0]?.y).toEqual([200]);
    expect(usdmBasePlot?.data?.[1]?.y).toEqual([200]);
    expect(usdmQuotePlot?.data?.[0]?.y).toEqual([200]);
    expect(usdmQuotePlot?.data?.[1]?.y).toEqual([200]);
  });
});
