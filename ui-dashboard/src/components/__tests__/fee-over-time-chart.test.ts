import { describe, expect, it } from "vitest";
import { revenueWeekOverWeekChangePct } from "@/components/fee-over-time-chart";
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
