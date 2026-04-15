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
  weekOverWeekChangePct,
} from "@/components/volume-over-time-chart";
import {
  TVL_NETWORK,
  makeNetworkData,
  makeSnapshot,
  makeTvlPool,
} from "@/test-utils/network-fixtures";
import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { TimeSeriesPoint } from "@/components/time-series-chart-card";

const SECONDS_PER_DAY = 86_400;

function dayAlignedNow(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function makeVolumeNetworkData(
  snapshotOverrides: object[] = [],
): NetworkData[] {
  return [
    makeNetworkData({
      network: TVL_NETWORK,
      pools: [makeTvlPool({ id: "pool-a" })],
      snapshots30d: snapshotOverrides.map((snapshot) =>
        makeSnapshot({ poolId: "pool-a", ...snapshot }),
      ),
    }),
  ];
}

function renderChart(
  overrides: Partial<React.ComponentProps<typeof VolumeOverTimeChart>> = {},
): string {
  const props: React.ComponentProps<typeof VolumeOverTimeChart> = {
    networkData: [],
    isLoading: false,
    hasError: false,
    hasSnapshotError: false,
    ...overrides,
  };

  return renderToStaticMarkup(React.createElement(VolumeOverTimeChart, props));
}

describe("buildDailyVolumeSeries", () => {
  it("fills missing UTC-day buckets with zero instead of forward-filling", () => {
    const today = dayAlignedNow();
    const day0 = today - 2 * SECONDS_PER_DAY;
    const day2 = today;

    const series = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        { timestamp: day0, swapVolume0: "1000000000000000000" },
        { timestamp: day2, swapVolume0: "3000000000000000000" },
      ]),
    );

    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({ timestamp: day0, volumeUSD: 1 });
    expect(series[1]).toMatchObject({
      timestamp: day0 + SECONDS_PER_DAY,
      volumeUSD: 0,
    });
    expect(series[2]).toMatchObject({ timestamp: day2, volumeUSD: 3 });
  });

  it("filters snapshots to the provided window before bucketing — partial edge buckets included", () => {
    // Three snapshots: one inside the window, one before, one at the window
    // boundary (exclusive). Bucketed totals should reflect only the in-window
    // snapshot; the leftmost bucket appears even though it only contains the
    // in-window portion of that UTC day (partial edge bar semantics).
    const dayStart = dayAlignedNow() - 3 * SECONDS_PER_DAY;
    const windowFrom = dayStart + 6 * 3600; // 6h into the day
    const windowTo = dayStart + 2 * SECONDS_PER_DAY + 6 * 3600;

    const series = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        { timestamp: dayStart + 2 * 3600, swapVolume0: "1000000000000000000" }, // before window → excluded
        { timestamp: dayStart + 10 * 3600, swapVolume0: "2000000000000000000" }, // inside → $2
        { timestamp: windowTo, swapVolume0: "4000000000000000000" }, // at upper bound (exclusive) → excluded
      ]),
      { from: windowFrom, to: windowTo },
    );

    // 3 buckets emitted (window spans parts of 3 UTC days); only the middle
    // one has volume since the other two snapshots were filtered out.
    const total = series.reduce((s, p) => s + p.volumeUSD, 0);
    expect(total).toBe(2);
  });

  it("returns empty when no snapshots fall inside the window", () => {
    const today = dayAlignedNow();
    const series = buildDailyVolumeSeries(
      makeVolumeNetworkData([
        {
          timestamp: today - 20 * SECONDS_PER_DAY,
          swapVolume0: "1000000000000000000",
        },
      ]),
      { from: today - 5 * SECONDS_PER_DAY, to: today },
    );
    expect(series).toEqual([]);
  });
});

describe("weekOverWeekChangePct", () => {
  function buildSeries(values: number[]): TimeSeriesPoint[] {
    const start = dayAlignedNow() - (values.length - 1) * SECONDS_PER_DAY;
    return values.map((value, i) => ({
      timestamp: start + i * SECONDS_PER_DAY,
      value,
    }));
  }

  it("returns null when fewer than 15 buckets exist", () => {
    expect(weekOverWeekChangePct(buildSeries(Array(14).fill(10)))).toBeNull();
  });

  it("returns null when the prior 7-day window is zero", () => {
    // 15 buckets: first 7 are prior window (zero), then 7 active days, then today
    const vals = [0, 0, 0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10, 10, 5];
    expect(weekOverWeekChangePct(buildSeries(vals))).toBeNull();
  });

  it("computes a positive delta comparing the last 7 full days vs the prior 7", () => {
    // prior 7 = sum 70, last 7 = sum 140, today (partial) = ignored
    const vals = [10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20, 99];
    expect(weekOverWeekChangePct(buildSeries(vals))).toBeCloseTo(100, 5);
  });

  it("excludes the trailing partial-day bucket from the last-7 window", () => {
    // prior 7 sum 70, last 7 sum 70 → 0%, today wildly different shouldn't matter
    const vals = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 999];
    expect(weekOverWeekChangePct(buildSeries(vals))).toBe(0);
  });
});

describe("VolumeOverTimeChart render", () => {
  beforeEach(() => {
    capturedPlotProps = {};
  });

  it("renders the 'Volume' title without a time-range suffix", () => {
    const html = renderChart();
    expect(html).toContain("Volume");
    expect(html).not.toContain("Volume (past 7d)");
    expect(html).not.toContain("Volume (24h)");
  });

  it("starts with the 1M range active by default", () => {
    const html = renderChart();
    expect(html).toMatch(/aria-pressed="true"[^>]*>1M</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>1W</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>All</);
  });

  it("exposes an 'All' range tab that maps to snapshotsAll", () => {
    // Series data lives in snapshotsAll (via the fixture default), so the
    // "All" tab is unfiltered and will include older snapshots that the 1M
    // tab would exclude. Default range is 1M so SSR won't show the summed
    // value — this test only asserts the tab is present and reachable.
    const html = renderChart({
      networkData: makeVolumeNetworkData([
        { timestamp: dayAlignedNow(), swapVolume0: "1000000000000000000" },
      ]),
    });
    expect(html).toContain(">All<");
  });

  it("renders N/A when no data and a top-level error", () => {
    const html = renderChart({ hasError: true });
    expect(html).toContain("N/A");
    expect(html).not.toContain("…");
  });

  it("renders N/A when snapshots partially failed and no data survived", () => {
    const html = renderChart({ hasSnapshotError: true });
    expect(html).toContain("N/A");
    expect(html).toContain("· partial data");
  });

  it("renders $0.00 (not N/A) when there's simply no volume yet and no errors", () => {
    const html = renderChart();
    expect(html).toContain("$0.00");
    expect(html).not.toContain("N/A");
  });

  it("renders a skeleton (not the real value or N/A) while loading", () => {
    const html = renderChart({ isLoading: true });
    expect(html).toMatch(/animate-pulse/);
    expect(html).not.toContain("…");
    expect(html).not.toContain("N/A");
  });

  it("renders 'Not enough history yet' when no data and no errors", () => {
    const html = renderChart();
    expect(html).toContain("Not enough history yet");
  });

  it("renders the top-level error empty state distinctly from partial-history empty state", () => {
    const errorHtml = renderChart({ hasError: true });
    const partialHtml = renderChart({ hasSnapshotError: true });

    expect(errorHtml).toContain("Unable to load volume history");
    expect(partialHtml).toContain(
      "Historical data partial — some chains failed to load",
    );
  });

  it("shows the headline as a formatted USD total covering the default (30d) range", () => {
    const today = dayAlignedNow();
    // Build two snapshots within the last 30 days that sum to $3
    const html = renderChart({
      networkData: makeVolumeNetworkData([
        {
          timestamp: today - SECONDS_PER_DAY,
          swapVolume0: "1000000000000000000",
        },
        { timestamp: today, swapVolume0: "2000000000000000000" },
      ]),
    });

    expect(html).toContain("$3.00");
    // At 30d default range we don't have two full 7d windows, so delta is null.
    expect(html).not.toContain("week-over-week");
  });

  it("passes Plotly config overrides when data is present", () => {
    const today = dayAlignedNow();
    renderChart({
      networkData: makeVolumeNetworkData([
        { timestamp: today, swapVolume0: "1000000000000000000" },
      ]),
    });

    expect(capturedPlotProps.config?.scrollZoom).toBe(false);
    expect(capturedPlotProps.config?.displayModeBar).toBe(false);
  });
});
