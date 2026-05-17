import { describe, expect, it } from "vitest";
import {
  breakdownVisibilityKey,
  hiddenSeriesKeysToIndexes,
} from "@/components/time-series-chart-card-hooks";
import type { BreakdownSeries } from "@/components/time-series-chart-card-overlays";

const point = { timestamp: 1, value: 1 };

function breakdown(overrides: Partial<BreakdownSeries>): BreakdownSeries {
  return {
    id: "series-a",
    name: "Series A",
    color: "#6366f1",
    series: [point],
    ...overrides,
  };
}

describe("hiddenSeriesKeysToIndexes", () => {
  it("drops hidden state for series that no longer exist after a breakdown shrink", () => {
    const hiddenKeys = new Set([
      breakdownVisibilityKey(breakdown({ id: "series-c" })),
    ]);

    const result = hiddenSeriesKeysToIndexes(
      [
        breakdown({ id: "series-a", name: "Series A" }),
        breakdown({ id: "series-b", name: "Series B" }),
      ],
      hiddenKeys,
    );

    expect([...result]).toEqual([]);
  });

  it("keeps hidden state attached to stable ids after a breakdown reorder", () => {
    const hiddenKeys = new Set([
      breakdownVisibilityKey(breakdown({ id: "series-c" })),
    ]);

    const result = hiddenSeriesKeysToIndexes(
      [
        breakdown({ id: "series-a", name: "Series A" }),
        breakdown({ id: "series-c", name: "Series C" }),
        breakdown({ id: "series-b", name: "Series B" }),
      ],
      hiddenKeys,
    );

    expect([...result]).toEqual([1]);
  });
});
