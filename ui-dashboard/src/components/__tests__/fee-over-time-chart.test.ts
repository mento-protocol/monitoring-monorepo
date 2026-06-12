import { describe, expect, it } from "vitest";
import {
  revenueChartYAxisRange,
  revenueChartEmptyMessage,
  revenueWeekOverWeekChangePct,
} from "@/components/fee-over-time-chart";
import type { CanonicalRevenueDailyPoint } from "@/lib/canonical-revenue";

const DAY = 86_400;
const START = Date.UTC(2026, 5, 1) / 1000;

function revenuePoint(
  index: number,
  totalRevenueUsd: number,
): CanonicalRevenueDailyPoint {
  return {
    timestamp: START + index * DAY,
    reserveYieldUsd: 0,
    swapFeesUsd: totalRevenueUsd,
    cdpBorrowingUsd: 0,
    totalRevenueUsd,
  };
}

describe("revenueWeekOverWeekChangePct", () => {
  it("returns the 7d week-over-week change when actual revenue inputs are complete", () => {
    const series = [
      ...Array.from({ length: 7 }, (_, index) => revenuePoint(index, 10)),
      ...Array.from({ length: 8 }, (_, index) => revenuePoint(index + 7, 20)),
    ];

    expect(revenueWeekOverWeekChangePct(series, "7d", [])).toBe(100);
  });

  it("suppresses the week-over-week change when actual revenue inputs are partial", () => {
    const series = [
      ...Array.from({ length: 7 }, (_, index) => revenuePoint(index, 10)),
      ...Array.from({ length: 8 }, (_, index) => revenuePoint(index + 7, 20)),
    ];

    expect(
      revenueWeekOverWeekChangePct(series, "7d", [
        "Swap fee history failed to load.",
      ]),
    ).toBeNull();
  });
});

describe("revenueChartEmptyMessage", () => {
  it("uses indexing copy only when revenue inputs are complete", () => {
    expect(revenueChartEmptyMessage([])).toBe("No revenue history indexed yet");
  });

  it("uses partial-data copy when input failures explain the empty chart", () => {
    expect(revenueChartEmptyMessage(["Swap fee history failed to load."])).toBe(
      "Revenue history is partial because some inputs failed to load",
    );
  });
});

describe("revenueChartYAxisRange", () => {
  it("keeps negative revenue days inside the visible y-axis range", () => {
    const range = revenueChartYAxisRange([
      {
        timestamp: START,
        reserveYieldUsd: -50,
        swapFeesUsd: 0,
        cdpBorrowingUsd: 0,
        totalRevenueUsd: -50,
      },
    ]);

    expect(range[0]).toBeLessThan(-50);
    expect(range[1]).toBeGreaterThan(0);
  });
});
