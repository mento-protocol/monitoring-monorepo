import { describe, expect, it } from "vitest";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
import {
  PEG_CHART,
  nearestPointIndex,
  pegChartBands,
  pegChartScale,
  pointX,
} from "../_lib/peg-chart-scale";

const policy = makePegMonitoringResponse().packages[0]!.policy;

describe("pegChartScale", () => {
  it("reproduces the mockup geometry for a +25/−50 bps policy", () => {
    const scale = pegChartScale(policy);
    expect(scale.topBps).toBeCloseTo(35, 6);
    expect(scale.bottomBps).toBeCloseTo(-70, 6);
    expect(scale.y(0)).toBeCloseTo(66.67, 2);
    expect(scale.y(25)).toBeCloseTo(19.05, 2);
    expect(scale.y(-25)).toBeCloseTo(114.29, 2);
    expect(scale.y(-50)).toBeCloseTo(161.9, 2);
  });

  it("follows a policy whose thresholds are not 25/50", () => {
    const scale = pegChartScale({
      ...policy,
      premiumWarnBps: 10,
      warnDeviationBps: 10,
      criticalDeviationBps: 100,
    });
    expect(scale.topBps).toBeCloseTo(14, 6);
    expect(scale.bottomBps).toBeCloseTo(-140, 6);
    expect(scale.y(10)).toBeLessThan(scale.y(0));
    expect(scale.y(-100)).toBeGreaterThan(scale.y(-10));
  });

  it("clamps values outside the fixed domain into the plot", () => {
    const scale = pegChartScale(policy);
    expect(scale.y(500)).toBe(0);
    expect(scale.y(-500)).toBe(PEG_CHART.plotHeight);
  });
});

describe("pegChartBands", () => {
  it("stacks premium, healthy, warning and critical bands over the plot", () => {
    const scale = pegChartScale(policy);
    const bands = pegChartBands(scale);
    expect(bands.map((band) => band.key)).toEqual([
      "premium",
      "healthy",
      "warning",
      "critical",
    ]);
    expect(bands[0]!.y).toBe(0);
    const total = bands.reduce((sum, band) => sum + band.height, 0);
    expect(total).toBeCloseTo(PEG_CHART.plotHeight, 6);
    expect(bands.at(-1)!.y + bands.at(-1)!.height).toBeCloseTo(
      PEG_CHART.plotHeight,
      6,
    );
  });

  it("gives the right-edge mini-rail a higher alpha than the plot band", () => {
    const bands = pegChartBands(pegChartScale(policy));
    expect(bands[1]!.fill).toContain("0.05");
    expect(bands[1]!.railFill).toContain("0.25");
  });
});

describe("series geometry", () => {
  it("spreads points evenly across the plot and pins the last one at the edge", () => {
    expect(pointX(0, 5)).toBe(0);
    expect(pointX(4, 5)).toBe(PEG_CHART.plotWidth);
    expect(pointX(2, 5)).toBe(PEG_CHART.plotWidth / 2);
    expect(pointX(0, 1)).toBe(PEG_CHART.plotWidth);
  });

  it("snaps a pointer position to the nearest reading", () => {
    expect(nearestPointIndex(0, 5)).toBe(0);
    expect(nearestPointIndex(PEG_CHART.plotWidth, 5)).toBe(4);
    expect(nearestPointIndex(PEG_CHART.plotWidth * 0.51, 5)).toBe(2);
    expect(nearestPointIndex(-40, 5)).toBe(0);
    expect(nearestPointIndex(5_000, 5)).toBe(4);
    expect(nearestPointIndex(123, 1)).toBe(0);
  });
});
