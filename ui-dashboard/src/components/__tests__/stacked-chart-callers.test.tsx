/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot() {
      return <div data-testid="plot" />;
    },
}));

import { StablesHeroChart } from "@/app/stables/_components/stables-hero-chart";
import type { StableSupplyDailySnapshot } from "@/app/stables/_lib/types";
import { AggregatorBreakdownSection } from "@/app/volume/_components/aggregator-breakdown-section";
import { VolumeChartArea } from "@/app/volume/_components/volume-page-sections";
import type { VolumePageModel, VolumeUrlState } from "@/app/volume/page-client";
import type { BreakdownSeries } from "@/components/time-series-chart-card";

const DAY = 86_400;

function plotCount(container: HTMLElement): number {
  return container.querySelectorAll("[data-testid=plot]").length;
}

function chartSeries(): Array<{ timestamp: number; value: number }> {
  const today = Math.floor(Date.now() / 1_000 / DAY) * DAY;
  return [
    { timestamp: today - DAY, value: 10 },
    { timestamp: today, value: 20 },
  ];
}

function breakdown(id: string, color: string): BreakdownSeries {
  return {
    id,
    name: id,
    color,
    series: chartSeries(),
  };
}

describe("stacked TimeSeriesChartCard caller matrix", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the stables hero on one steady Plot", () => {
    const today = Math.floor(Date.now() / 1_000 / DAY) * DAY;
    const snapshot: StableSupplyDailySnapshot = {
      id: `42220-0xstable-${today}`,
      chainId: 42220,
      tokenAddress: "0xstable",
      tokenSymbol: "USDm",
      source: "RESERVE",
      tokenDecimals: 18,
      timestamp: String(today),
      totalSupply: "100000000000000000000",
      dailyMintAmount: "0",
      dailyBurnAmount: "0",
    };

    act(() => {
      root.render(
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
    });

    expect(plotCount(container)).toBe(1);
    expect(container.textContent).toContain("Mento stablecoin supply");
  });

  it("keeps the aggregator breakdown on one steady Plot", () => {
    const series = chartSeries();
    act(() => {
      root.render(
        <AggregatorBreakdownSection
          venueLabel="v3"
          rangeLabel="1M"
          aggregators={[]}
          isLoading={false}
          hasError={false}
          isCapHit={false}
          chart={{
            series,
            breakdown: [
              breakdown("Aggregator A", "#6366f1"),
              breakdown("Aggregator B", "#10b981"),
            ],
            range: "30d",
            onRangeChange: () => undefined,
            ranges: [{ key: "30d", label: "1M" }],
            headline: "$30",
          }}
        />,
      );
    });

    expect(plotCount(container)).toBe(1);
    expect(container.textContent).toContain("v3 volume by aggregator");
  });

  it("keeps the per-pool custom-legend section on its single-Plot path", () => {
    const poolBreakdown = [
      { ...breakdown("Pool A", "#6366f1"), legendIcon: null },
      { ...breakdown("Pool B", "#10b981"), legendIcon: null },
    ];
    const model = {
      showChart: true,
      poolChartRange: "30d",
      poolChart: {
        poolVolumeBreakdown: {
          totalSeries: chartSeries(),
          windowTotalUsdWei: BigInt(30),
        },
        chartBreakdown: poolBreakdown,
        topPoolsListEntries: [],
      },
      poolChartRange: "30d",
      chartControls: {
        chartRange: "30d",
        onChartRangeChange: () => undefined,
      },
      headline: "$30",
      status: {
        poolChartIsLoading: false,
        poolChartHasError: false,
      },
    } as unknown as VolumePageModel;
    const urlState = { range: "30d" } as unknown as VolumeUrlState;

    act(() => {
      root.render(<VolumeChartArea urlState={urlState} model={model} />);
    });

    expect(plotCount(container)).toBe(1);
    expect(container.textContent).toContain("Volume by pool");
    expect(container.textContent).toContain("Pool A");
    expect(container.textContent).toContain("Pool B");
  });
});
