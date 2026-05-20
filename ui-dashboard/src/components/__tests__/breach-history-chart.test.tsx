import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviationThresholdBreach } from "@/lib/types";

type PlotTrace = {
  name?: string;
  customdata?: string[][];
};

let capturedPlotProps: Array<{ data?: PlotTrace[] }> = [];

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot(props: { data?: PlotTrace[] }) {
      capturedPlotProps.push(props);
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

import { BreachHistoryChart } from "@/components/breach-history-chart";

const BASE_BREACH: DeviationThresholdBreach = {
  id: "breach-1",
  chainId: 42220,
  poolId: "42220-0x000000000000000000000000000000000000aaaa",
  startedAt: "1704486600",
  startedAtBlock: "1",
  endedAt: null,
  endedAtBlock: null,
  durationSeconds: null,
  criticalDurationSeconds: null,
  entryPriceDifference: "11000",
  entryRebalanceThreshold: 10000,
  peakPriceDifference: "11000",
  peakAt: "1704486600",
  peakAtBlock: "1",
  startedByEvent: "oracle_update",
  startedByTxHash: "0xstart",
  endedByEvent: null,
  endedByTxHash: null,
  endedByStrategy: null,
  rebalanceCountDuring: 0,
};

beforeEach(() => {
  capturedPlotProps = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderOpenCriticalBreach(nowIso: string) {
  vi.spyOn(Date, "now").mockReturnValue(new Date(nowIso).getTime());

  renderToStaticMarkup(<BreachHistoryChart breaches={[BASE_BREACH]} />);

  const [plot] = capturedPlotProps;
  const ongoingTrace = plot?.data?.find((trace) => trace.name === "Ongoing");
  return ongoingTrace?.customdata?.[0];
}

describe("BreachHistoryChart", () => {
  it("does not count weekend wall-clock time against open-breach grace", () => {
    const customdata = renderOpenCriticalBreach("2024-01-07T23:15:00.000Z");

    expect(customdata?.[0]).toBe("45m");
    expect(customdata?.[1]).toBe("0s");
  });

  it("emits past-grace seconds only after one trading hour elapses", () => {
    const customdata = renderOpenCriticalBreach("2024-01-07T23:45:00.000Z");

    expect(customdata?.[0]).toBe("1h 15m");
    expect(customdata?.[1]).toBe("15m");
  });
});
