import { afterEach, describe, it, expect, vi } from "vitest";
import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  dateTickFormatForSeries,
  rangeKeyToDays,
  snapshotRange,
} from "../time-series";

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

describe("snapshotRange", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses hourly buckets when requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:34:00Z"));

    expect(
      snapshotRange(
        [{ timestamp: 1_783_340_401 }, { timestamp: 1_783_344_001 }],
        SECONDS_PER_HOUR,
      ),
    ).toEqual({
      from: 1_783_339_200,
      to: 1_783_346_400,
      bucketSeconds: SECONDS_PER_HOUR,
    });
  });

  it("uses daily buckets when requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:34:00Z"));

    expect(
      snapshotRange([{ timestamp: 1_783_340_401 }], SECONDS_PER_DAY),
    ).toEqual({
      from: 1_783_296_000,
      to: 1_783_382_400,
      bucketSeconds: SECONDS_PER_DAY,
    });
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
