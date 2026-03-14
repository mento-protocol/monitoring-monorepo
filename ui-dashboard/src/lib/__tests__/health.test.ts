import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  computeHealthStatus,
  computeEffectiveStatus,
  formatDeviationPct,
  computeLimitStatus,
  computeRebalancerLiveness,
  worstStatus,
  getOracleStalenessThreshold,
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

  it('returns "NO_DATA" when lastRebalancedAt is missing (FPMM with no history)', () => {
    expect(computeRebalancerLiveness({ source: "fpmm_factory" }, NOW)).toBe(
      "NO_DATA",
    );
  });

  it('returns "NO_DATA" when lastRebalancedAt is "0" (FPMM with no history)', () => {
    expect(
      computeRebalancerLiveness(
        { source: "fpmm_factory", lastRebalancedAt: "0" },
        NOW,
      ),
    ).toBe("NO_DATA");
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

describe("worstStatus", () => {
  it("returns CRITICAL over all others", () => {
    expect(worstStatus("CRITICAL", "OK")).toBe("CRITICAL");
    expect(worstStatus("OK", "CRITICAL")).toBe("CRITICAL");
    expect(worstStatus("CRITICAL", "WARN")).toBe("CRITICAL");
    expect(worstStatus("CRITICAL", "N/A")).toBe("CRITICAL");
  });

  it("returns WARN over OK and N/A", () => {
    expect(worstStatus("WARN", "OK")).toBe("WARN");
    expect(worstStatus("OK", "WARN")).toBe("WARN");
    expect(worstStatus("WARN", "N/A")).toBe("WARN");
  });

  it("returns OK over N/A", () => {
    expect(worstStatus("OK", "N/A")).toBe("OK");
    expect(worstStatus("N/A", "OK")).toBe("OK");
  });

  it("returns same value when both are equal", () => {
    expect(worstStatus("OK", "OK")).toBe("OK");
    expect(worstStatus("N/A", "N/A")).toBe("N/A");
  });
});

describe("computeEffectiveStatus", () => {
  it("returns the oracle health when limit is better", () => {
    expect(
      computeEffectiveStatus({
        source: "fpmm_factory",
        oracleTimestamp: FRESH_TS,
        priceDifference: "5000",
        rebalanceThreshold: 5000,
        limitPressure0: "0.1",
        limitPressure1: "0.1",
      }),
    ).toBe("CRITICAL");
  });

  it("returns the limit status when it is worse than oracle health", () => {
    expect(
      computeEffectiveStatus({
        source: "fpmm_factory",
        oracleTimestamp: FRESH_TS,
        priceDifference: "0",
        rebalanceThreshold: 5000,
        limitPressure0: "1.05",
        limitPressure1: "0",
      }),
    ).toBe("CRITICAL");
  });

  it("uses the pre-indexed limitStatus field when present", () => {
    expect(
      computeEffectiveStatus({
        source: "fpmm_factory",
        oracleTimestamp: FRESH_TS,
        priceDifference: "0",
        rebalanceThreshold: 5000,
        limitStatus: "WARN",
        limitPressure0: "0",
        limitPressure1: "0",
      }),
    ).toBe("WARN");
  });

  it("returns N/A for VirtualPools regardless of limit pressure", () => {
    expect(
      computeEffectiveStatus({
        source: "virtual_pool_factory",
        limitPressure0: "1.5",
        limitPressure1: "1.5",
      }),
    ).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// Oracle staleness boundary (300s)
// Timestamps are derived from a frozen clock so these tests are deterministic.
// ---------------------------------------------------------------------------
describe("computeHealthStatus oracle staleness boundary", () => {
  const FROZEN_NOW_MS = 1_700_000_000_000;
  const frozenNowSec = Math.floor(FROZEN_NOW_MS / 1000);

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_MS);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("oracle 120s old (well within 300s window) is fresh → OK", () => {
    const ts120 = String(frozenNowSec - 120);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts120,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });

  it("oracle at 301s is stale → CRITICAL", () => {
    const ts301 = String(frozenNowSec - 301);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts301,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("CRITICAL");
  });

  it("oracle at exactly 300s is not stale (age <= 300) → OK", () => {
    const ts300 = String(frozenNowSec - 300);
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

// ---------------------------------------------------------------------------
// Oracle staleness with per-feed oracleExpiry (non-default, e.g. Monad)
// ---------------------------------------------------------------------------
describe("computeHealthStatus per-feed oracleExpiry", () => {
  const FROZEN_NOW_MS = 1_700_000_000_000;
  const frozenNowSec = Math.floor(FROZEN_NOW_MS / 1000);

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_MS);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("400s-old oracle with oracleExpiry=600 is fresh → OK", () => {
    // Would be CRITICAL at the default 300s threshold; the longer expiry keeps it OK.
    const ts400 = String(frozenNowSec - 400);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts400,
        oracleExpiry: "600",
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });

  it("601s-old oracle with oracleExpiry=600 is stale → CRITICAL", () => {
    const ts601 = String(frozenNowSec - 601);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts601,
        oracleExpiry: "600",
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("CRITICAL");
  });

  it("oracleExpiry=0 falls back to 300s default", () => {
    // "0" means not yet indexed — should behave identically to the default 300s window.
    const ts301 = String(frozenNowSec - 301);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts301,
        oracleExpiry: "0",
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("CRITICAL");
  });

  it("missing oracleExpiry field falls back to 300s default", () => {
    const ts301 = String(frozenNowSec - 301);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts301,
        priceDifference: "0",
        rebalanceThreshold: 5000,
        // oracleExpiry intentionally omitted
      }),
    ).toBe("CRITICAL");
  });

  it("oracleExpiry=600: 300s-old oracle that would be stale at default is still OK", () => {
    // Boundary: age === default 300s but custom expiry is 600s → fresh
    const ts300 = String(frozenNowSec - 300);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: ts300,
        oracleExpiry: "600",
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Per-chain fallback for getOracleStalenessThreshold
// ---------------------------------------------------------------------------
describe("getOracleStalenessThreshold per-chain fallback", () => {
  it("Monad mainnet (143): fallback = 360s when oracleExpiry is 0", () => {
    expect(getOracleStalenessThreshold({ oracleExpiry: "0" }, 143)).toBe(360);
  });

  it("Celo mainnet (42220): fallback = 300s when oracleExpiry is 0", () => {
    expect(getOracleStalenessThreshold({ oracleExpiry: "0" }, 42220)).toBe(300);
  });

  it("Unknown chain: fallback = 300s (ORACLE_STALE_SECONDS default)", () => {
    expect(getOracleStalenessThreshold({ oracleExpiry: "0" }, 99999)).toBe(300);
  });

  it("Unknown chain with no chainId arg: fallback = 300s", () => {
    expect(getOracleStalenessThreshold({ oracleExpiry: "0" })).toBe(300);
  });

  it("Pool with oracleExpiry > 0 overrides chain fallback (Monad 143)", () => {
    // oracleExpiry=600 should win over the chain default of 360
    expect(getOracleStalenessThreshold({ oracleExpiry: "600" }, 143)).toBe(600);
  });

  it("Pool with oracleExpiry > 0 overrides chain fallback (Celo 42220)", () => {
    expect(getOracleStalenessThreshold({ oracleExpiry: "480" }, 42220)).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// computeHealthStatus uses per-chain fallback when oracleExpiry is missing
// ---------------------------------------------------------------------------
describe("computeHealthStatus per-chain fallback via chainId", () => {
  const FROZEN_NOW_MS = 1_700_000_000_000;
  const frozenNowSec = Math.floor(FROZEN_NOW_MS / 1000);

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_MS);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("Monad (143): 340s-old oracle is fresh (360s fallback)", () => {
    // 340s < 360s → OK. At Celo's 300s threshold this would be CRITICAL.
    const ts = String(frozenNowSec - 340);
    expect(
      computeHealthStatus(
        { source: "fpmm_factory", oracleTimestamp: ts, priceDifference: "0", rebalanceThreshold: 5000 },
        143,
      ),
    ).toBe("OK");
  });

  it("Monad (143): 361s-old oracle is stale → CRITICAL", () => {
    const ts = String(frozenNowSec - 361);
    expect(
      computeHealthStatus(
        { source: "fpmm_factory", oracleTimestamp: ts, priceDifference: "0", rebalanceThreshold: 5000 },
        143,
      ),
    ).toBe("CRITICAL");
  });

  it("Celo (42220): 301s-old oracle is stale → CRITICAL (300s fallback)", () => {
    const ts = String(frozenNowSec - 301);
    expect(
      computeHealthStatus(
        { source: "fpmm_factory", oracleTimestamp: ts, priceDifference: "0", rebalanceThreshold: 5000 },
        42220,
      ),
    ).toBe("CRITICAL");
  });

  it("Unknown chain: 301s-old oracle is stale → CRITICAL (300s default)", () => {
    const ts = String(frozenNowSec - 301);
    expect(
      computeHealthStatus(
        { source: "fpmm_factory", oracleTimestamp: ts, priceDifference: "0", rebalanceThreshold: 5000 },
        99999,
      ),
    ).toBe("CRITICAL");
  });

  it("oracleExpiry > 0 overrides chain fallback: 340s-old with expiry=600 on Celo is fresh", () => {
    // Even on Celo (300s fallback), if oracleExpiry=600 is indexed then 340s is fresh.
    const ts = String(frozenNowSec - 340);
    expect(
      computeHealthStatus(
        { source: "fpmm_factory", oracleTimestamp: ts, oracleExpiry: "600", priceDifference: "0", rebalanceThreshold: 5000 },
        42220,
      ),
    ).toBe("OK");
  });
});
