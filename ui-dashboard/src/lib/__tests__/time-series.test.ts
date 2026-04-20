import { describe, it, expect } from "vitest";
import { rangeKeyToDays } from "../time-series";

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
