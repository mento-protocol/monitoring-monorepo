import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpInstanceDailySnapshot } from "../../../_lib/types";
import {
  CdpStabilityPoolTvlChart,
  buildRebalanceReserveReference,
  buildStabilityPoolTvlSeries,
} from "../cdp-stability-pool-tvl-chart";

type CapturedChartProps = {
  annotations?: Plotly.Layout["annotations"];
  shapes?: Plotly.Layout["shapes"];
  yAxisReferenceValues?: readonly number[];
};

const capturedChartProps = vi.hoisted(() => ({
  current: null as CapturedChartProps | null,
}));

vi.mock("@/components/time-series-chart-card", () => ({
  TimeSeriesChartCard: (props: CapturedChartProps) => {
    capturedChartProps.current = props;
    return null;
  },
}));

const WEI = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * WEI).toString();
}

function snapshot(
  timestamp: number,
  spDeposits: string,
): CdpInstanceDailySnapshot {
  return {
    id: `gbpm-${timestamp}`,
    timestamp: String(timestamp),
    spDeposits,
    spColl: "0",
    spHeadroom: "0",
    systemDebt: "0",
    systemColl: "0",
  };
}

describe("buildStabilityPoolTvlSeries", () => {
  it("drops bootstrap-era zero snapshots before the first real SP TVL", () => {
    const bootstrap = 1_704_067_200; // 2024-01-01
    const firstDeposit = 1_747_008_000; // 2025-05-12
    const now = 1_767_225_600;

    const series = buildStabilityPoolTvlSeries(
      [snapshot(firstDeposit, wei(1_000)), snapshot(bootstrap, "0")],
      wei(5_000),
      now,
    );

    expect(series.map((point) => point.timestamp)).toEqual([firstDeposit, now]);
    expect(series.map((point) => point.value)).toEqual([1_000, 5_000]);
  });

  it("preserves zero TVL after the pool previously had deposits", () => {
    const firstDeposit = 1_747_008_000;
    const withdrawal = firstDeposit + 86_400;
    const now = withdrawal + 86_400;

    const series = buildStabilityPoolTvlSeries(
      [snapshot(withdrawal, "0"), snapshot(firstDeposit, wei(1_000))],
      "0",
      now,
    );

    expect(series.map((point) => point.timestamp)).toEqual([
      firstDeposit,
      withdrawal,
      now,
    ]);
    expect(series.map((point) => point.value)).toEqual([1_000, 0, 0]);
  });

  it("collapses an all-zero history to the latest point", () => {
    const bootstrap = 1_704_067_200;
    const later = bootstrap + 86_400;
    const now = later + 86_400;

    const series = buildStabilityPoolTvlSeries(
      [snapshot(later, "0"), snapshot(bootstrap, "0")],
      "0",
      now,
    );

    expect(series).toEqual([{ timestamp: now, value: 0 }]);
  });
});

describe("buildRebalanceReserveReference", () => {
  it("builds a dashed reserve line and label", () => {
    const reference = buildRebalanceReserveReference(wei(5_000), "GBPm");

    expect(reference?.shapes?.[0]).toMatchObject({
      type: "line",
      y0: 5_000,
      y1: 5_000,
      line: { color: "#f59e0b", dash: "dash" },
    });
    expect(reference?.annotations?.[0]).toMatchObject({
      y: 5_000,
      text: "Rebalance reserve 5,000.00 GBPm",
      showarrow: false,
    });
    expect(reference?.yAxisReferenceValues).toEqual([5_000]);
  });

  it("omits the reserve marker when the system parameter is missing", () => {
    expect(buildRebalanceReserveReference(null, "GBPm")).toBeNull();
  });

  it("omits the reserve marker when the system parameter is zero", () => {
    expect(buildRebalanceReserveReference("0", "GBPm")).toBeNull();
  });
});

describe("CdpStabilityPoolTvlChart", () => {
  beforeEach(() => {
    capturedChartProps.current = null;
  });

  it("passes the rebalance reserve marker into the chart shell", () => {
    renderToStaticMarkup(
      React.createElement(CdpStabilityPoolTvlChart, {
        snapshots: [snapshot(1_747_008_000, wei(5_000))],
        currentSpDeposits: wei(5_000),
        minBoldAfterRebalance: wei(5_000),
        symbol: "GBPm",
        isLoading: false,
        hasError: false,
      }),
    );

    expect(capturedChartProps.current?.shapes?.[0]).toMatchObject({
      y0: 5_000,
      y1: 5_000,
    });
    expect(capturedChartProps.current?.annotations?.[0]?.text).toBe(
      "Rebalance reserve 5,000.00 GBPm",
    );
    expect(capturedChartProps.current?.yAxisReferenceValues).toEqual([5_000]);
  });
});
