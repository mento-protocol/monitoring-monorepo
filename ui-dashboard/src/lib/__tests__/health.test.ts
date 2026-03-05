import { describe, it, expect } from "vitest";
import { computeHealthStatus, formatDeviationPct } from "../health";

describe("computeHealthStatus", () => {
  it('returns "N/A" for VirtualPools (source includes "virtual")', () => {
    expect(
      computeHealthStatus({
        source: "virtual_pool_factory",
        oracleOk: true,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("N/A");
  });

  it('returns "N/A" when source contains "virtual" anywhere', () => {
    expect(
      computeHealthStatus({
        source: "fpmm_virtual_test",
        oracleOk: true,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("N/A");
  });

  it('returns "CRITICAL" when oracleOk is false', () => {
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: false,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("CRITICAL");
  });

  it('returns "OK" when oracle is fresh and deviation is low', () => {
    // priceDifference = 1000, threshold = 5000 → ratio = 0.2 → OK
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        priceDifference: "1000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });

  it('returns "WARN" when deviation is >= 80% of threshold', () => {
    // priceDifference = 4000, threshold = 5000 → ratio = 0.8 → WARN
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        priceDifference: "4000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("WARN");
  });

  it('returns "WARN" for ratio exactly 0.8', () => {
    // ratio = 4000/5000 = 0.8 → WARN (>= 0.8)
    expect(
      computeHealthStatus({
        source: "fpmm_update_reserves",
        oracleOk: true,
        priceDifference: "4000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("WARN");
  });

  it('returns "CRITICAL" when deviation >= threshold', () => {
    // priceDifference = 5000, threshold = 5000 → ratio = 1.0 → CRITICAL
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        priceDifference: "5000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("CRITICAL");
  });

  it('returns "CRITICAL" when deviation exceeds threshold', () => {
    // priceDifference = 8000, threshold = 5000 → ratio = 1.6 → CRITICAL
    expect(
      computeHealthStatus({
        source: "fpmm_rebalanced",
        oracleOk: true,
        priceDifference: "8000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("CRITICAL");
  });

  it("uses fallback threshold of 10000 when rebalanceThreshold is 0", () => {
    // ratio = 9000/10000 = 0.9 → WARN (>= 0.8)
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        priceDifference: "9000",
        rebalanceThreshold: 0,
      }),
    ).toBe("WARN");
  });

  it("handles missing fields gracefully (defaults to CRITICAL for stale oracle)", () => {
    // No oracleOk means false → CRITICAL
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
      }),
    ).toBe("CRITICAL");
  });

  it("returns OK for zero priceDifference with valid threshold", () => {
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });
});

describe("formatDeviationPct", () => {
  it("formats zero deviation as 0%", () => {
    expect(formatDeviationPct("0", 5000)).toBe("0.0%");
  });

  it("formats partial deviation correctly", () => {
    // 2500 / 5000 = 50%
    expect(formatDeviationPct("2500", 5000)).toBe("50.0%");
  });

  it("formats full deviation as 100%", () => {
    expect(formatDeviationPct("5000", 5000)).toBe("100.0%");
  });

  it("returns 0% when threshold is 0", () => {
    expect(formatDeviationPct("1234", 0)).toBe("0%");
  });
});
