import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let capturedPlotProps: {
  data?: unknown;
  layout?: Record<string, unknown>;
  config?: Record<string, unknown>;
} = {};

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot(props: {
      data: unknown;
      layout: Record<string, unknown>;
      config: Record<string, unknown>;
    }) {
      capturedPlotProps = props;
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

import {
  VolumeOverTimeChart,
  buildDailyVolumeSeries,
} from "@/components/volume-over-time-chart";
import {
  TVL_NETWORK,
  makeNetworkData,
  makeSnapshot,
  makeTvlPool,
} from "@/test-utils/network-fixtures";

const SECONDS_PER_DAY = 86_400;

function dayAlignedNow(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

describe("buildDailyVolumeSeries", () => {
  it("fills missing UTC-day buckets with zero instead of forward-filling", () => {
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const day2 = today;

    const pool = makeTvlPool({
      id: "pool-a",
      notionalVolume0: "0",
      notionalVolume1: "0",
    });

    const series = buildDailyVolumeSeries([
      makeNetworkData({
        network: TVL_NETWORK,
        pools: [pool],
        snapshots30d: [
          makeSnapshot({
            poolId: "pool-a",
            timestamp: day0,
            swapVolume0: "1000000000000000000",
          }),
          makeSnapshot({
            poolId: "pool-a",
            timestamp: day2,
            swapVolume0: "3000000000000000000",
          }),
        ],
      }),
    ]);

    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({ timestamp: day0, volumeUSD: 1 });
    expect(series[1]).toMatchObject({
      timestamp: day0 + SECONDS_PER_DAY,
      volumeUSD: 0,
    });
    expect(series[2]).toMatchObject({ timestamp: day2, volumeUSD: 3 });
  });
});

describe("VolumeOverTimeChart render", () => {
  beforeEach(() => {
    capturedPlotProps = {};
  });

  it("renders N/A, not ellipsis, for partial historical data when the 7d total is unavailable", () => {
    const today = dayAlignedNow();
    const pool = makeTvlPool({ id: "pool-a" });
    const html = renderToStaticMarkup(
      React.createElement(VolumeOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [pool],
            snapshots30d: [
              makeSnapshot({
                poolId: "pool-a",
                timestamp: today,
                swapVolume0: "1000000000000000000",
              }),
            ],
          }),
        ],
        totalVolume7d: null,
        change7d: null,
        isLoading: false,
        hasError: false,
        hasSnapshotError: true,
      }),
    );

    expect(html).toContain("N/A");
    expect(html).toContain("· partial data");
    expect(html).not.toContain("…");
  });

  it("renders 'Not enough history yet' when no data and no errors", () => {
    const html = renderToStaticMarkup(
      React.createElement(VolumeOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [],
            snapshots30d: [],
          }),
        ],
        totalVolume7d: 0,
        change7d: null,
        isLoading: false,
        hasError: false,
        hasSnapshotError: false,
      }),
    );

    expect(html).toContain("Not enough history yet");
  });

  it("renders a positive delta pill and Plotly config overrides", () => {
    const today = dayAlignedNow();
    const pool = makeTvlPool({ id: "pool-a" });

    const html = renderToStaticMarkup(
      React.createElement(VolumeOverTimeChart, {
        networkData: [
          makeNetworkData({
            network: TVL_NETWORK,
            pools: [pool],
            snapshots30d: [
              makeSnapshot({
                poolId: "pool-a",
                timestamp: today,
                swapVolume0: "1000000000000000000",
              }),
            ],
          }),
        ],
        totalVolume7d: 1,
        change7d: 12.34,
        isLoading: false,
        hasError: false,
        hasSnapshotError: false,
      }),
    );

    expect(html).toContain("+12.34%");
    expect(html).toContain("week-over-week");
    expect(capturedPlotProps.config?.scrollZoom).toBe(false);
    expect(capturedPlotProps.config?.displayModeBar).toBe(false);
  });
});
