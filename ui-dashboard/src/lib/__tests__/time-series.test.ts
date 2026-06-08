import { describe, it, expect } from "vitest";
import { dateTickFormatForSeries, rangeKeyToDays } from "../time-series";

describe("rangeKeyToDays", () => {
  it("returns 7 for the 7d key", () => {
    expect(rangeKeyToDays("7d")).toBe(7);
  });

  it("returns 30 for the 30d key", () => {
    expect(rangeKeyToDays("30d")).toBe(30);
  });

  it("returns null for the 'all' key (no cutoff)", () => {
    expect(rangeKeyToDays("all")).toBeNull();
  });
});

describe("dateTickFormatForSeries", () => {
  it("keeps day labels for short windows", () => {
    expect(
      dateTickFormatForSeries([
        { timestamp: 1_700_000_000, value: 1 },
        { timestamp: 1_700_000_000 + 30 * 86_400, value: 2 },
      ]),
    ).toBe("%b %d");
  });

  it("uses month-year labels for medium all-time windows", () => {
    expect(
      dateTickFormatForSeries([
        { timestamp: 1_700_000_000, value: 1 },
        { timestamp: 1_700_000_000 + 180 * 86_400, value: 2 },
      ]),
    ).toBe("%b %Y");
  });

  it("uses years for multi-year windows so Jan 01 ticks are not repeated", () => {
    expect(
      dateTickFormatForSeries([
        { timestamp: 1_700_000_000, value: 1 },
        { timestamp: 1_700_000_000 + 800 * 86_400, value: 2 },
      ]),
    ).toBe("%Y");
  });
});
