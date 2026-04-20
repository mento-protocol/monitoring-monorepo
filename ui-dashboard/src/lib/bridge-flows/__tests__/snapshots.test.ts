import { describe, it, expect } from "vitest";
import {
  buildCountSeries,
  buildTokenBreakdown,
  buildVolumeUsdSeries,
  snapshotUsdValue,
  weekOverWeekChange,
  windowTotals,
} from "../snapshots";
import type { OracleRateMap } from "@/lib/tokens";
import { makeSnapshot as mk } from "./fixtures";

const DAY = 86_400;

const emptyRates: OracleRateMap = new Map();
const ratesWithGbp: OracleRateMap = new Map([["GBPm", 1.32]]);

describe("snapshotUsdValue", () => {
  it("prefers indexer-pinned usdValueAtSend when finite", () => {
    expect(
      snapshotUsdValue(
        { tokenSymbol: "USDm", sentVolume: "0", sentUsdValue: "123.45" },
        emptyRates,
      ),
    ).toBe(123.45);
  });

  it("falls back to live rate for USDm (1:1 peg, no rate needed)", () => {
    expect(
      snapshotUsdValue(
        {
          tokenSymbol: "USDm",
          sentVolume: "5000000000000000000", // 5 tokens @ 18dp
          sentUsdValue: null,
        },
        emptyRates,
      ),
    ).toBe(5);
  });

  it("applies the oracle rate for non-pegged tokens", () => {
    expect(
      snapshotUsdValue(
        {
          tokenSymbol: "GBPm",
          sentVolume: "100000000000000000000", // 100 tokens
          sentUsdValue: null,
        },
        ratesWithGbp,
      ),
    ).toBeCloseTo(132);
  });

  it("returns 0 when we can't price the token", () => {
    expect(
      snapshotUsdValue(
        {
          tokenSymbol: "FOO",
          sentVolume: "100000000000000000000",
          sentUsdValue: null,
        },
        emptyRates,
      ),
    ).toBe(0);
  });

  it("falls back to live rate when usdValueAtSend is a non-finite string", () => {
    expect(
      snapshotUsdValue(
        {
          tokenSymbol: "USDm",
          sentVolume: "1000000000000000000",
          sentUsdValue: "not-a-number",
        },
        emptyRates,
      ),
    ).toBe(1);
  });

  it("treats the legacy '0.00' sentinel as null (falls back to live rate)", () => {
    // Pre-nullable-schema indexer deployments wrote "0.00" on every row;
    // accepting that as a real USD reading would flatten KPIs to $0.
    expect(
      snapshotUsdValue(
        {
          tokenSymbol: "USDm",
          sentVolume: "3000000000000000000",
          sentUsdValue: "0.00",
        },
        emptyRates,
      ),
    ).toBe(3);
  });
});

describe("buildVolumeUsdSeries", () => {
  // Pre-floored to UTC day start so the bucketing round-trip is identity.
  const DAY_START = 1_700_000_000 - (1_700_000_000 % DAY);

  it("sums USD per day across routes/tokens", () => {
    const day1 = DAY_START;
    const day2 = day1 + DAY;
    const snaps = [
      mk({ date: String(day1), sentUsdValue: "100" }),
      mk({ date: String(day1), sentUsdValue: "50" }),
      mk({ date: String(day2), sentUsdValue: "200" }),
    ];
    const series = buildVolumeUsdSeries(snaps, emptyRates);
    expect(series).toHaveLength(2);
    expect(series[0]).toEqual({ timestamp: day1, value: 150 });
    expect(series[1]).toEqual({ timestamp: day2, value: 200 });
  });

  it("sorts ascending by timestamp regardless of input order", () => {
    const day1 = DAY_START;
    const day2 = day1 + DAY;
    const snaps = [
      mk({ date: String(day2), sentUsdValue: "200" }),
      mk({ date: String(day1), sentUsdValue: "100" }),
    ];
    const series = buildVolumeUsdSeries(snaps, emptyRates);
    expect(series.map((p) => p.timestamp)).toEqual([day1, day2]);
  });

  it("returns [] for empty input", () => {
    expect(buildVolumeUsdSeries([], emptyRates)).toEqual([]);
  });

  it("floors timestamps to UTC day start", () => {
    const mid = 1_700_000_000;
    const floored = mid - (mid % DAY);
    const snaps = [mk({ date: String(mid), sentUsdValue: "42" })];
    const [point] = buildVolumeUsdSeries(snaps, emptyRates);
    expect(point.timestamp).toBe(floored);
  });
});

describe("buildCountSeries", () => {
  it("sums sentCount per day", () => {
    const day = 1_700_000_000 - (1_700_000_000 % DAY);
    const snaps = [
      mk({ date: String(day), sentCount: 3 }),
      mk({ date: String(day), sentCount: 2 }),
    ];
    expect(buildCountSeries(snaps)).toEqual([{ timestamp: day, value: 5 }]);
  });
});

describe("windowTotals", () => {
  it("returns null total + zero subs for empty input", () => {
    expect(windowTotals([], () => 1)).toEqual({
      total: null,
      sub24h: 0,
      sub7d: 0,
      sub30d: 0,
    });
  });

  it("accumulates per-window via the getter", () => {
    const now = 1_700_100_000;
    const snaps = [
      mk({ date: String(now), sentCount: 1 }), // in 24h
      mk({ date: String(now - 2 * DAY), sentCount: 5 }), // in 7d, not 24h
      mk({ date: String(now - 10 * DAY), sentCount: 10 }), // in 30d, not 7d
      mk({ date: String(now - 40 * DAY), sentCount: 100 }), // outside 30d
    ];
    const totals = windowTotals(snaps, (s) => s.sentCount ?? 0, now);
    expect(totals.total).toBe(116);
    expect(totals.sub24h).toBe(1);
    expect(totals.sub7d).toBe(6); // 1 + 5
    expect(totals.sub30d).toBe(16); // 1 + 5 + 10
  });
});

describe("weekOverWeekChange", () => {
  it("returns +100% when prior week had zero but current has activity", () => {
    const now = 1_700_100_000;
    const series = [
      { timestamp: now - 1 * DAY, value: 50 },
      { timestamp: now - 3 * DAY, value: 30 },
    ];
    expect(weekOverWeekChange(series, now)).toBe(100);
  });

  it("returns null when both weeks are empty", () => {
    const now = 1_700_100_000;
    expect(weekOverWeekChange([], now)).toBeNull();
  });

  it("computes percentage delta between weeks", () => {
    const now = 1_700_100_000;
    const series = [
      { timestamp: now - 1 * DAY, value: 200 }, // this week
      { timestamp: now - 10 * DAY, value: 100 }, // last week
    ];
    expect(weekOverWeekChange(series, now)).toBe(100);
  });
});

describe("buildTokenBreakdown", () => {
  const now = 1_700_100_000;

  it("groups by token, sums USD, sorts descending", () => {
    const snaps = [
      mk({
        date: String(now - 5 * DAY),
        tokenSymbol: "USDm",
        sentUsdValue: "100",
      }),
      mk({
        date: String(now - 10 * DAY),
        tokenSymbol: "GBPm",
        sentUsdValue: "500",
      }),
      mk({
        date: String(now - 2 * DAY),
        tokenSymbol: "USDm",
        sentUsdValue: "50",
      }),
    ];
    const slices = buildTokenBreakdown(snaps, emptyRates, 30, now);
    expect(slices).toEqual([
      { symbol: "GBPm", usd: 500 },
      { symbol: "USDm", usd: 150 },
    ]);
  });

  it("excludes rows outside the window", () => {
    const snaps = [
      mk({
        date: String(now - 40 * DAY),
        tokenSymbol: "USDm",
        sentUsdValue: "1000",
      }),
      mk({
        date: String(now - 1 * DAY),
        tokenSymbol: "USDm",
        sentUsdValue: "10",
      }),
    ];
    const slices = buildTokenBreakdown(snaps, emptyRates, 30, now);
    expect(slices).toEqual([{ symbol: "USDm", usd: 10 }]);
  });

  it("excludes 0-USD tokens", () => {
    const snaps = [
      mk({
        date: String(now - 1 * DAY),
        tokenSymbol: "UNKNOWN",
        sentUsdValue: null,
        sentVolume: "1000",
      }),
    ];
    expect(buildTokenBreakdown(snaps, emptyRates, 30, now)).toEqual([]);
  });
});
