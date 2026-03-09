import { describe, it, expect } from "vitest";
import {
  computeHealthStatus,
  formatDeviationPct,
  computeLimitStatus,
  computeRebalancerLiveness,
} from "../health";

/** A recent oracle timestamp (2 minutes ago) — within 5-min SortedOracles expiry. */
const FRESH_TS = String(Math.floor(Date.now() / 1000) - 120);
/** A stale oracle timestamp (10 minutes ago) — beyond 5-min SortedOracles expiry. */
const STALE_TS = String(Math.floor(Date.now() / 1000) - 600);

describe("computeHealthStatus", () => {
  it('returns "N/A" for VirtualPools (source includes "virtual")', () => {
    expect(
      computeHealthStatus({
        source: "virtual_pool_factory",
        oracleOk: true,
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: STALE_TS,
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
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: FRESH_TS,
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
        oracleTimestamp: FRESH_TS,
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

describe("computeLimitStatus", () => {
  it('returns "N/A" for VirtualPools (source includes "virtual")', () => {
    expect(
      computeLimitStatus({
        source: "virtual_pool_factory",
        limitPressure0: "0.9",
        limitPressure1: "0.9",
      }),
    ).toBe("N/A");
  });

  it('returns "OK" when max pressure < 0.8', () => {
    expect(
      computeLimitStatus({
        source: "fpmm_factory",
        limitPressure0: "0.1",
        limitPressure1: "0.5",
      }),
    ).toBe("OK");
  });

  it('returns "WARN" when max pressure >= 0.8', () => {
    expect(
      computeLimitStatus({
        source: "fpmm_factory",
        limitPressure0: "0.3",
        limitPressure1: "0.85",
      }),
    ).toBe("WARN");
  });

  it('returns "WARN" for exactly 0.8 pressure', () => {
    expect(
      computeLimitStatus({
        source: "fpmm_factory",
        limitPressure0: "0.8",
        limitPressure1: "0.0",
      }),
    ).toBe("WARN");
  });

  it('returns "CRITICAL" when max pressure >= 1.0', () => {
    expect(
      computeLimitStatus({
        source: "fpmm_factory",
        limitPressure0: "0.5",
        limitPressure1: "1.0",
      }),
    ).toBe("CRITICAL");
  });

  it('returns "CRITICAL" when pressure exceeds 1.0', () => {
    expect(
      computeLimitStatus({
        source: "fpmm_factory",
        limitPressure0: "1.5",
        limitPressure1: "0.2",
      }),
    ).toBe("CRITICAL");
  });

  it('returns "OK" when pressures are missing (defaults to 0)', () => {
    expect(computeLimitStatus({ source: "fpmm_factory" })).toBe("OK");
  });
});

describe("computeRebalancerLiveness", () => {
  const NOW = 1_000_000;

  it('returns "N/A" for VirtualPools', () => {
    expect(
      computeRebalancerLiveness(
        { source: "virtual_pool", lastRebalancedAt: "999000" },
        NOW,
      ),
    ).toBe("N/A");
  });

  it('returns "N/A" when lastRebalancedAt is missing', () => {
    expect(computeRebalancerLiveness({ source: "fpmm_factory" }, NOW)).toBe(
      "N/A",
    );
  });

  it('returns "N/A" when lastRebalancedAt is "0"', () => {
    expect(
      computeRebalancerLiveness(
        { source: "fpmm_factory", lastRebalancedAt: "0" },
        NOW,
      ),
    ).toBe("N/A");
  });

  it('returns "ACTIVE" when rebalanced within 24h', () => {
    // 1h ago
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 3600),
          healthStatus: "CRITICAL",
        },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it('returns "STALE" when age > 86400 and healthStatus is not OK', () => {
    // 25h ago, CRITICAL health
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 90000),
          healthStatus: "CRITICAL",
        },
        NOW,
      ),
    ).toBe("STALE");
  });

  it('returns "ACTIVE" when age > 86400 but healthStatus is OK', () => {
    // 25h ago but health is OK
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 90000),
          healthStatus: "OK",
        },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it('returns "STALE" when age > 86400 and healthStatus is WARN', () => {
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 90000),
          healthStatus: "WARN",
        },
        NOW,
      ),
    ).toBe("STALE");
  });

  it('returns "ACTIVE" for exactly 86400s age (boundary)', () => {
    // exactly at boundary — age is NOT > 86400, so ACTIVE
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 86400),
          healthStatus: "CRITICAL",
        },
        NOW,
      ),
    ).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Oracle staleness boundary (300s)
// ---------------------------------------------------------------------------
describe("computeHealthStatus oracle staleness boundary", () => {
  it("oracle at exactly 300s is fresh (age <= 300 → OK)", () => {
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: FRESH_TS, // within 300s
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });

  it("oracle at 301s is stale → CRITICAL", () => {
    const ts301 = String(Math.floor(Date.now() / 1000) - 301);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts301,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("CRITICAL");
  });

  it("oracle at exactly 300s is not stale (age <= 300)", () => {
    const ts300 = String(Math.floor(Date.now() / 1000) - 300);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts300,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });
});
