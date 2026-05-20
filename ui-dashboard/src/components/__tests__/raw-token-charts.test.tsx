import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolSnapshot, ReserveUpdate } from "@/lib/types";

let capturedPlotProps: Array<{
  data?: Array<{ y?: number[]; customdata?: number[] }>;
}> = [];

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot(props: {
      data: Array<{ y?: number[]; customdata?: number[] }>;
    }) {
      capturedPlotProps.push(props);
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

vi.mock("@/components/network-provider", () => ({
  useNetwork: () => ({
    network: { id: "celo-mainnet", chainId: 42220, tokenSymbols: {} },
  }),
}));

import { ReserveChart } from "@/components/reserve-chart";
import { SnapshotChart } from "@/components/snapshot-chart";

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
  token1Decimals: 6,
  tokenDecimalsKnown: true,
};

const SNAPSHOT: PoolSnapshot = {
  id: "snap-1",
  poolId: BASE_POOL.id,
  timestamp: "1767225600",
  reserves0: "0",
  reserves1: "0",
  swapCount: 1,
  swapVolume0: "1000000000000000000",
  swapVolume1: "2000000",
  rebalanceCount: 0,
  cumulativeSwapCount: 1,
  cumulativeVolume0: "1000000000000000000",
  cumulativeVolume1: "2000000",
  blockNumber: "1",
};

const RESERVE: ReserveUpdate = {
  id: "reserve-1",
  chainId: 42220,
  poolId: BASE_POOL.id,
  reserve0: "1000000000000000000",
  reserve1: "2000000",
  blockTimestampInPool: "1767225600",
  blockNumber: "1",
  blockTimestamp: "1767225600",
  txHash: "0x1",
};

beforeEach(() => {
  capturedPlotProps = [];
});

describe("raw token charts", () => {
  it("scales snapshot swap volumes with per-token decimals", () => {
    renderToStaticMarkup(
      <SnapshotChart snapshots={[SNAPSHOT]} pool={BASE_POOL} />,
    );

    const [plot] = capturedPlotProps;
    expect(plot?.data?.[0]?.y).toEqual([1]);
    expect(plot?.data?.[1]?.y).toEqual([2]);
  });

  it("does not render snapshot volumes before decimals are trusted", () => {
    const html = renderToStaticMarkup(
      <SnapshotChart
        snapshots={[SNAPSHOT]}
        pool={{ ...BASE_POOL, tokenDecimalsKnown: false }}
      />,
    );

    expect(html).toBe("");
    expect(capturedPlotProps).toEqual([]);
  });

  it("scales reserve history and hover raw amounts with per-token decimals", () => {
    renderToStaticMarkup(
      <ReserveChart
        rows={[RESERVE]}
        token0={null}
        token1={null}
        pool={BASE_POOL}
      />,
    );

    const [plot] = capturedPlotProps;
    expect(plot?.data?.[0]?.y).toEqual([1]);
    expect(plot?.data?.[1]?.y).toEqual([2]);
    expect(plot?.data?.[0]?.customdata).toEqual([1]);
    expect(plot?.data?.[1]?.customdata).toEqual([2]);
  });

  it("does not render reserve history before decimals are trusted", () => {
    const html = renderToStaticMarkup(
      <ReserveChart
        rows={[RESERVE]}
        token0={null}
        token1={null}
        pool={{ ...BASE_POOL, tokenDecimalsKnown: false }}
      />,
    );

    expect(html).toBe("");
    expect(capturedPlotProps).toEqual([]);
  });
});
