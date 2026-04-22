import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  computeHealthStatus,
  computeEffectiveStatus,
  formatDeviationPct,
  computeLimitStatus,
  computeRebalancerLiveness,
  worstStatus,
} from "../health";

// Mock weekend.ts so health tests are deterministic regardless of real-world day.
// Override per-test when WEEKEND behaviour needs to be tested.
vi.mock("../weekend", () => ({
  isWeekend: vi.fn(() => false),
  isWeekendOracleStale: vi.fn(() => false),
  FX_CLOSE_DAY: 5,
  FX_CLOSE_HOUR_UTC: 21,
  FX_REOPEN_DAY: 0,
  FX_REOPEN_HOUR_UTC: 23,
}));

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

  it('stays "OK" when deviation is at 80% of threshold — no longer warns near the line', () => {
    // priceDifference = 4000, threshold = 5000 → ratio = 0.8. Under the new
    // rule, "close to breach" is not actionable, so nothing to warn about.
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        oracleTimestamp: FRESH_TS,
        priceDifference: "4000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });

  it('stays "OK" when deviation is exactly at the threshold', () => {
    // priceDifference = 5000, threshold = 5000 → ratio = 1.0. At-threshold
    // is still healthy; WARN only kicks in strictly above.
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        oracleTimestamp: FRESH_TS,
        priceDifference: "5000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("OK");
  });

  it('returns "WARN" on a fresh breach without a breach-start anchor', () => {
    // Indexer hasn't populated deviationBreachStartedAt yet — stay at WARN
    // rather than spuriously jump to CRITICAL.
    expect(
      computeHealthStatus({
        source: "fpmm_rebalanced",
        oracleOk: true,
        oracleTimestamp: FRESH_TS,
        priceDifference: "8000",
        rebalanceThreshold: 5000,
      }),
    ).toBe("WARN");
  });

  it('returns "WARN" while the breach is within the 1h grace window', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      computeHealthStatus(
        {
          source: "fpmm_factory",
          oracleTimestamp: FRESH_TS,
          priceDifference: "8000",
          rebalanceThreshold: 5000,
          deviationBreachStartedAt: String(now - 30 * 60), // 30 min ago
        },
        undefined,
        now,
      ),
    ).toBe("WARN");
  });

  it("escalates to CRITICAL once the breach outlasts the grace window", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      computeHealthStatus(
        {
          source: "fpmm_factory",
          oracleTimestamp: FRESH_TS,
          priceDifference: "8000",
          rebalanceThreshold: 5000,
          deviationBreachStartedAt: String(now - 2 * 3600), // 2h ago — past 1h
        },
        undefined,
        now,
      ),
    ).toBe("CRITICAL");
  });

  it("stays WARN one second before the 1h grace window expires", () => {
    // breachAge = 3599s; code uses `< DEVIATION_BREACH_GRACE_SECONDS`
    // (= 3600), so 3599 still counts as in-grace. Pin the boundary so
    // silent drift (e.g. flipping to `<=`) doesn't shrink the window.
    const now = Math.floor(Date.now() / 1000);
    expect(
      computeHealthStatus(
        {
          source: "fpmm_factory",
          oracleTimestamp: FRESH_TS,
          priceDifference: "8000",
          rebalanceThreshold: 5000,
          deviationBreachStartedAt: String(now - 3599),
        },
        undefined,
        now,
      ),
    ).toBe("WARN");
  });

  it("flips to CRITICAL at exactly the 1h grace window boundary", () => {
    // breachAge = 3600s; boundary is strict `<`, so 3600 is NOT in-grace.
    const now = Math.floor(Date.now() / 1000);
    expect(
      computeHealthStatus(
        {
          source: "fpmm_factory",
          oracleTimestamp: FRESH_TS,
          priceDifference: "8000",
          rebalanceThreshold: 5000,
          deviationBreachStartedAt: String(now - 3600),
        },
        undefined,
        now,
      ),
    ).toBe("CRITICAL");
  });

  it("treats null deviationBreachStartedAt as a fresh breach → WARN, not CRITICAL", () => {
    // Hasura emits null for absent nullable fields. Without an anchor we
    // can't know how long the breach has lasted — stay at WARN until the
    // indexer catches up.
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: FRESH_TS,
        priceDifference: "8000",
        rebalanceThreshold: 5000,
        deviationBreachStartedAt: null,
      }),
    ).toBe("WARN");
  });

  it("uses fallback threshold of 10000 when rebalanceThreshold is 0", () => {
    // ratio = 9000/10000 = 0.9 — still OK under the new rule.
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleOk: true,
        oracleTimestamp: FRESH_TS,
        priceDifference: "9000",
        rebalanceThreshold: 0,
      }),
    ).toBe("OK");
  });

  it("handles missing fields gracefully (defaults to CRITICAL for stale oracle)", () => {
    // No oracleOk means false → CRITICAL
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
      }),
    ).toBe("CRITICAL");
  });

  it('returns "WEEKEND" instead of CRITICAL when oracle is stale during weekend', async () => {
    const weekend = await import("../weekend");
    vi.mocked(weekend.isWeekend).mockReturnValueOnce(true);
    expect(
      computeHealthStatus({
        source: "fpmm_factory",
        oracleTimestamp: STALE_TS,
        priceDifference: "0",
        rebalanceThreshold: 5000,
      }),
    ).toBe("WEEKEND");
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
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 3600),
          priceDifference: "15000",
          rebalanceThreshold: 10000,
        },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it('returns "STALE" when age > 24h and the pool is above threshold', () => {
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 90000),
          priceDifference: "15000",
          rebalanceThreshold: 10000,
        },
        NOW,
      ),
    ).toBe("STALE");
  });

  it('returns "ACTIVE" when age > 24h but the pool is under threshold (nothing to do)', () => {
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 90000),
          priceDifference: "3000",
          rebalanceThreshold: 10000,
        },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it('returns "ACTIVE" when age > 24h and pool sits exactly at threshold', () => {
    // diff === threshold — still under the "needs rebalance" line, so
    // silence from the rebalancer is expected.
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 90000),
          priceDifference: "10000",
          rebalanceThreshold: 10000,
        },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it('returns "ACTIVE" for exactly 86400s age (boundary)', () => {
    expect(
      computeRebalancerLiveness(
        {
          source: "fpmm_factory",
          lastRebalancedAt: String(NOW - 86400),
          priceDifference: "15000",
          rebalanceThreshold: 10000,
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
    // priceDifference = 6000, threshold = 5000 → ratio = 1.2 → CRITICAL once
    // the breach outlives the 1h grace window.
    const now = Math.floor(Date.now() / 1000);
    expect(
      computeEffectiveStatus({
        source: "fpmm_factory",
        oracleTimestamp: FRESH_TS,
        priceDifference: "6000",
        rebalanceThreshold: 5000,
        deviationBreachStartedAt: String(now - 2 * 3600),
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

// Oracle staleness boundary (300s)
// Timestamps are derived from a frozen clock so these tests are deterministic.
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

// Oracle staleness with per-feed oracleExpiry (non-default, e.g. Monad)
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

// Chain-aware fallback via ORACLE_STALE_SECONDS_BY_CHAIN
describe("computeHealthStatus chain-aware staleness fallback", () => {
  const FROZEN_NOW_MS = 1_700_000_000_000;
  const frozenNowSec = Math.floor(FROZEN_NOW_MS / 1000);

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_MS);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("Monad (chainId=143): 340s-old oracle with oracleExpiry=0 is fresh (360s fallback)", () => {
    // Would be CRITICAL at the 300s default, but Monad's fallback is 360s
    const ts340 = String(frozenNowSec - 340);
    expect(
      computeHealthStatus(
        {
          source: "fpmm_factory",
          oracleTimestamp: ts340,
          oracleExpiry: "0",
          priceDifference: "0",
          rebalanceThreshold: 5000,
        },
        143, // Monad mainnet chainId
      ),
    ).toBe("OK");
  });

  it("Monad (chainId=143): 361s-old oracle with oracleExpiry=0 is stale", () => {
    const ts361 = String(frozenNowSec - 361);
    expect(
      computeHealthStatus(
        {
          source: "fpmm_factory",
          oracleTimestamp: ts361,
          oracleExpiry: "0",
          priceDifference: "0",
          rebalanceThreshold: 5000,
        },
        143,
      ),
    ).toBe("CRITICAL");
  });

  it("unknown chainId falls back to 300s default", () => {
    const ts301 = String(frozenNowSec - 301);
    expect(
      computeHealthStatus(
        {
          source: "fpmm_factory",
          oracleTimestamp: ts301,
          oracleExpiry: "0",
          priceDifference: "0",
          rebalanceThreshold: 5000,
        },
        99999, // unknown chain
      ),
    ).toBe("CRITICAL");
  });
});
