import { describe, expect, it } from "vitest";
import {
  DAILY_MODE_SPAN_SECONDS,
  buildDailyPlotData,
  computeOracleYRange,
  type OracleDailyCandle,
} from "../oracle-daily";

// Fixidity 1e24 string from a float (6dp precision). Avoids BigInt literals —
// the dashboard tsconfig targets ES2017, which forbids them even in tests.
const fix = (n: number): string =>
  n.toFixed(6).replace(".", "") + "0".repeat(18);

function candle(overrides: Partial<OracleDailyCandle> = {}): OracleDailyCandle {
  return {
    bucketStart: "1780012800", // 2026-05-29 UTC day boundary
    openPrice: fix(1),
    highPrice: fix(1.01),
    lowPrice: fix(0.99),
    closePrice: fix(1),
    sampleCount: 100,
    anyOutOfBand: false,
    maxDeviationRatio: "0.500000",
    endBreakerBaselineAtSnapshot: fix(1),
    endBreakerThresholdAtSnapshot: fix(0.01),
    ...overrides,
  };
}

describe("DAILY_MODE_SPAN_SECONDS", () => {
  it("is 60 days in seconds", () => {
    expect(DAILY_MODE_SPAN_SECONDS).toBe(60 * 86400);
  });
});

describe("buildDailyPlotData", () => {
  it("encodes x as ISO strings matching the raw trace (the daily/raw seam)", () => {
    const c = candle({ bucketStart: "1780012800" });
    const { deviationTrace } = buildDailyPlotData({
      candles: [c],
      baseline: 1,
      thresholdRatio: 0.01,
    });
    // Identical encoding to buildOraclePlotData: new Date(sec*1000).toISOString()
    const expectedX = new Date(1780012800 * 1000).toISOString();
    expect((deviationTrace.x as string[])[0]).toBe(expectedX);
  });

  it("plots y = closePrice / 1e24", () => {
    const { deviationTrace } = buildDailyPlotData({
      candles: [candle({ closePrice: fix(1.234) })],
      baseline: 1,
      thresholdRatio: 0.01,
    });
    expect((deviationTrace.y as number[])[0]).toBeCloseTo(1.234, 6);
  });

  it("colors from anyOutOfBand directly — a recovered-by-close trip stays red", () => {
    // close == baseline (in-band) but the day tripped → red, NOT recomputed green.
    const { deviationTrace } = buildDailyPlotData({
      candles: [
        candle({ anyOutOfBand: false, closePrice: fix(1) }), // green
        candle({ anyOutOfBand: true, closePrice: fix(1) }), // red despite in-band close
      ],
      baseline: 1,
      thresholdRatio: 0.01,
    });
    const colors = (deviationTrace.marker as { color: string[] }).color;
    expect(colors[0]).toBe("#22c55e");
    expect(colors[1]).toBe("#ef4444");
  });

  it("does NOT decimate — every candle is rendered", () => {
    const candles = Array.from({ length: 3000 }, (_, i) =>
      candle({ bucketStart: String(1700000000 + i * 86400) }),
    );
    const { deviationTrace } = buildDailyPlotData({
      candles,
      baseline: 1,
      thresholdRatio: 0.01,
    });
    expect((deviationTrace.x as string[]).length).toBe(3000);
  });

  it("uses markers-only for a sparse series, lines+markers otherwise", () => {
    const sparse = buildDailyPlotData({
      candles: [candle()],
      baseline: 1,
      thresholdRatio: 0.01,
    });
    expect(sparse.deviationTrace.mode).toBe("markers");

    const dense = buildDailyPlotData({
      candles: Array.from({ length: 25 }, (_, i) =>
        candle({ bucketStart: String(1700000000 + i * 86400) }),
      ),
      baseline: 1,
      thresholdRatio: 0.01,
    });
    expect(dense.deviationTrace.mode).toBe("lines+markers");
  });

  it("hover text carries the date, OHLC, and sample count", () => {
    const { deviationTrace } = buildDailyPlotData({
      candles: [candle({ sampleCount: 42 })],
      baseline: 1,
      thresholdRatio: 0.01,
    });
    const hover = (deviationTrace.text as string[])[0]!;
    expect(hover).toContain("2026-05-29");
    expect(hover).toContain("O ");
    expect(hover).toContain("C ");
    expect(hover).toContain("42 medians");
  });
});

describe("computeOracleYRange", () => {
  it("includes a band edge that sits near the data", () => {
    const { yMin, yMax } = computeOracleYRange([1.0], 1.0, 0.01);
    // band [0.99, 1.01] is within margin of the (flat) data → both included,
    // then 15% padding on the 0.02 span.
    expect(yMin).toBeCloseTo(0.987, 4);
    expect(yMax).toBeCloseTo(1.013, 4);
  });

  it("floors a flat dataset so the axis is non-degenerate", () => {
    const { yMin, yMax } = computeOracleYRange([5, 5, 5], null, null);
    expect(yMax).toBeGreaterThan(yMin);
    expect(yMin).toBeLessThan(5);
    expect(yMax).toBeGreaterThan(5);
  });

  it("ignores NaN prices when bounding", () => {
    const { yMin, yMax } = computeOracleYRange([Number.NaN, 2, 3], null, null);
    expect(yMin).toBeLessThan(2);
    expect(yMax).toBeGreaterThan(3);
  });
});
