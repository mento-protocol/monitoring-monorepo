import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolSnapshot, ReserveUpdate } from "@/lib/types";

let capturedPlotProps: Array<{
  data?: Array<{
    x?: string[];
    y?: Array<number | null>;
    customdata?: number[];
  }>;
  layout?: { shapes?: Array<Record<string, unknown>> };
}> = [];

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot(props: {
      data: Array<{
        x?: string[];
        y?: Array<number | null>;
        customdata?: number[];
      }>;
      layout?: { shapes?: Array<Record<string, unknown>> };
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

function snapshot(
  overrides: Partial<PoolSnapshot> & { timestamp: string },
): PoolSnapshot {
  const { timestamp, ...rest } = overrides;
  return {
    ...SNAPSHOT,
    id: `snap-${timestamp}`,
    timestamp,
    ...rest,
  };
}

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
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Number(SNAPSHOT.timestamp) * 1000));
  capturedPlotProps = [];
});

afterEach(() => {
  vi.useRealTimers();
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

  it("zero-fills missing swap-volume days and forward-fills cumulative swaps", () => {
    const day0 = 1767225600;
    const day2 = day0 + 2 * 86_400;
    vi.setSystemTime(new Date(day2 * 1000));

    renderToStaticMarkup(
      <SnapshotChart
        snapshots={[
          snapshot({
            timestamp: String(day2),
            swapVolume0: "3000000000000000000",
            swapVolume1: "6000000",
            cumulativeSwapCount: 3,
          }),
          snapshot({
            timestamp: String(day0),
            swapVolume0: "1000000000000000000",
            swapVolume1: "2000000",
            cumulativeSwapCount: 1,
          }),
        ]}
        pool={BASE_POOL}
      />,
    );

    const [plot] = capturedPlotProps;
    expect(plot?.data?.[0]?.y).toEqual([1, 0, 3]);
    expect(plot?.data?.[1]?.y).toEqual([2, 0, 6]);
    expect(plot?.data?.[2]?.y).toEqual([1, 1, 3]);
  });

  it("adds FX weekend bands to FPMM snapshot charts", () => {
    const friClose = Math.floor(
      new Date("2026-03-13T21:00:00Z").getTime() / 1000,
    );
    vi.setSystemTime(new Date("2026-03-16T00:00:00Z"));

    renderToStaticMarkup(
      <SnapshotChart
        snapshots={[
          snapshot({ timestamp: String(friClose + 3 * 86_400) }),
          snapshot({ timestamp: String(friClose - 86_400) }),
        ]}
        pool={{ ...BASE_POOL, token0: "0xusd", token1: "0xeur" }}
        network={{
          id: "celo-mainnet",
          label: "Celo",
          chainId: 42220,
          contractsNamespace: null,
          hasuraUrl: "https://example.com",
          hasuraSecret: "",
          explorerBaseUrl: "https://celoscan.io",
          tokenSymbols: { "0xusd": "USDm", "0xeur": "EURm" },
          addressLabels: {},
          local: false,
          hasVirtualPools: false,
          testnet: false,
        }}
      />,
    );

    const [plot] = capturedPlotProps;
    expect(plot?.layout?.shapes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "rect",
          x0: "2026-03-13T21:00:00.000Z",
          x1: "2026-03-15T23:00:00.000Z",
        }),
      ]),
    );
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
