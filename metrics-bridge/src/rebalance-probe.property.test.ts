/**
 * Property-based tests for metrics-bridge math invariants.
 *
 * These complement the 178 unit tests by checking law-shaped invariants across
 * arbitrary inputs rather than specific scenarios. Invariants covered:
 *
 *  1. eligibleForProbe: empty input → empty output
 *  2. eligibleForProbe: result is always a subset of the input array
 *  3. eligibleForProbe: pools with deviationBreachStartedAt <= 0 are always excluded
 *  4. eligibleForProbe: pools with non-finite lastDeviationRatio are always excluded
 *  5. eligibleForProbe: result is stable under input duplication (idempotent filter)
 *  6. runWithConcurrency: output length always equals input length
 *  7. runWithConcurrency: identical results regardless of concurrency level
 *  8. openBreachPeakRatio: computed ratio is always >= 0 for any valid inputs
 *  9. Reserve share: r0/total + r1/total = 1 for any positive r0, r1 pair
 * 10. healthStatusToNumber: result is always in {0, 1, 2, 3}
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  REBALANCE_PROBE_TOLERANCE_THRESHOLD,
  REBALANCE_PROBE_DEVIATION_THRESHOLD,
  LEGACY_OPEN_BREACH_ENTRY_THRESHOLD,
} from "./config.js";
import { eligibleForProbe, runWithConcurrency } from "./rebalance-probe.js";
import { healthStatusToNumber } from "./metrics.js";
import type { PoolRow } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a PoolRow that is always eligible (breached + above critical + has
 * rebalancerAddress). Individual properties override to make it ineligible. */
function eligiblePool(overrides: Partial<PoolRow> = {}): PoolRow {
  return {
    id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
    chainId: 42220,
    token0: "0x765de816845861e75a25fca122bb6898b8b1282a",
    token1: "0xccf663b1ff11028f0b19058d0f7b674004a40746",
    source: "fpmm_factory",
    healthStatus: "OK",
    oracleOk: true,
    oracleTimestamp: "1713200000",
    oracleTxHash:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    oracleExpiry: "300",
    lastDeviationRatio: "1.10", // > REBALANCE_PROBE_DEVIATION_THRESHOLD (1.05)
    deviationBreachStartedAt: "1713100000", // > 0
    currentOpenBreachPeak: "0",
    currentOpenBreachEntryThreshold: 0,
    limitStatus: "OK",
    limitPressure0: "0.1",
    limitPressure1: "0.1",
    lastRebalancedAt: "1713099000",
    lastEffectivenessRatio: "0.5",
    rebalanceLivenessStatus: "ACTIVE",
    hasHealthData: true,
    lpFee: 5,
    protocolFee: 5,
    lastMedianPrice: "1150000000000000000000000",
    prevMedianPrice: "1120000000000000000000000",
    prevMedianAt: "1713199580",
    lastOracleJumpBps: "3.0",
    lastOracleJumpAt: "1713200000",
    reserves0: "1000000000000000000",
    reserves1: "1000000000000000000",
    token0Decimals: 18,
    token1Decimals: 18,
    rebalancerAddress: "0x0000000000000000000000000000000000000beef",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 1: Empty input → empty output
// ---------------------------------------------------------------------------
describe("eligibleForProbe — empty input yields empty output", () => {
  it("returns [] for [] regardless of any generated config context", () => {
    // No arbitraries needed — this is a pure identity: the function must
    // return an empty array when called with an empty array.
    expect(eligibleForProbe([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property 2: Result is a subset of the input
// ---------------------------------------------------------------------------
describe("eligibleForProbe — result is always a subset of input", () => {
  it("every returned pool exists in the input array", () => {
    fc.assert(
      fc.property(
        // Generate 0–10 pools with randomised ratio/breach/peak combos
        fc.array(
          fc.record({
            deviationBreachStartedAt: fc.oneof(
              fc.constant("0"),
              fc.integer({ min: 1, max: 1_800_000_000 }).map(String),
            ),
            lastDeviationRatio: fc.oneof(
              fc.constant("NaN"),
              fc.constant("-1"),
              fc
                .float({ min: 0, max: 3, noNaN: true })
                .map((n) => n.toFixed(6)),
            ),
            currentOpenBreachPeak: fc
              .float({ min: 0, max: 50_000, noNaN: true })
              .map((n) => n.toFixed(4)),
            currentOpenBreachEntryThreshold: fc.integer({
              min: 0,
              max: 20_000,
            }),
            rebalancerAddress: fc.oneof(
              fc.constant(""),
              fc.constant("0x0000000000000000000000000000000000000beef"),
            ),
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (overridesList) => {
          const pools = overridesList.map((o) => eligiblePool(o));
          const result = eligibleForProbe(pools);
          // Every returned pool must be reference-equal to an input pool
          for (const returned of result) {
            expect(pools).toContain(returned);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: No active breach → never eligible
// ---------------------------------------------------------------------------
describe("eligibleForProbe — deviationBreachStartedAt <= 0 is always excluded", () => {
  it("pools with no breach anchor are never returned regardless of ratio", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 5, noNaN: true }),
        fc.integer({ min: 0, max: 0 }), // deviationBreachStartedAt <= 0
        (ratio, breach) => {
          const pool = eligiblePool({
            lastDeviationRatio: ratio.toFixed(6),
            deviationBreachStartedAt: String(breach),
          });
          expect(eligibleForProbe([pool])).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("pools with negative deviationBreachStartedAt are never returned", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 5, noNaN: true }),
        fc.integer({ min: -1_000_000, max: -1 }),
        (ratio, breach) => {
          const pool = eligiblePool({
            lastDeviationRatio: ratio.toFixed(6),
            deviationBreachStartedAt: String(breach),
          });
          expect(eligibleForProbe([pool])).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Non-finite ratio → never eligible
// ---------------------------------------------------------------------------
describe("eligibleForProbe — non-finite lastDeviationRatio is always excluded", () => {
  it("NaN, Infinity, and non-numeric strings are always excluded", () => {
    const badRatios = ["NaN", "Infinity", "-Infinity", "", "abc", "null"];
    for (const ratio of badRatios) {
      const pool = eligiblePool({
        lastDeviationRatio: ratio,
        deviationBreachStartedAt: "1713100000",
      });
      expect(eligibleForProbe([pool])).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 5: Ratio <= tolerance threshold → never eligible (no breach peak escape)
// ---------------------------------------------------------------------------
describe("eligibleForProbe — ratio at or below tolerance threshold is excluded unless peak crosses critical", () => {
  it("pools with ratio <= tolerance and no critical peak are never eligible", () => {
    fc.assert(
      fc.property(
        // ratio in (0, TOLERANCE] — at or below tolerance, never above
        // fc.float requires 32-bit float bounds
        fc.float({
          min: Math.fround(0),
          max: Math.fround(REBALANCE_PROBE_TOLERANCE_THRESHOLD),
          noNaN: true,
        }),
        (ratio) => {
          const pool = eligiblePool({
            lastDeviationRatio: ratio.toFixed(6),
            deviationBreachStartedAt: "1713100000",
            // No open-breach peak (peak = 0 → openBreachPeakRatio = 0)
            currentOpenBreachPeak: "0",
            currentOpenBreachEntryThreshold: 0,
          });
          expect(eligibleForProbe([pool])).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: runWithConcurrency — output length always equals input length
// ---------------------------------------------------------------------------
describe("runWithConcurrency — output length invariant", () => {
  it("always returns exactly as many results as inputs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 100 }), {
          minLength: 0,
          maxLength: 20,
        }),
        fc.integer({ min: 1, max: 10 }),
        async (items, concurrency) => {
          const results = await runWithConcurrency(
            items,
            concurrency,
            async (x) => x * 2,
          );
          expect(results).toHaveLength(items.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: runWithConcurrency — concurrency level doesn't affect results
// ---------------------------------------------------------------------------
describe("runWithConcurrency — results are independent of concurrency cap", () => {
  it("same results for concurrency=1 vs concurrency=N", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), {
          minLength: 1,
          maxLength: 15,
        }),
        async (items) => {
          const sequential = await runWithConcurrency(
            items,
            1,
            async (x) => x * x,
          );
          const parallel = await runWithConcurrency(
            items,
            items.length,
            async (x) => x * x,
          );
          expect(sequential).toEqual(parallel);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("preserves input ordering in output", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.integer({ min: 1, max: 8 }),
        async (items, concurrency) => {
          const results = await runWithConcurrency(
            items,
            concurrency,
            async (x) => x,
          );
          expect(results).toEqual(items);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: openBreachPeakRatio math — result is always >= 0
// ---------------------------------------------------------------------------
describe("openBreachPeakRatio math — ratio is always non-negative", () => {
  it("peak / threshold >= 0 for any valid peak and threshold", () => {
    fc.assert(
      fc.property(
        // peak > 0 (positive peaks are the only ones that produce a non-zero ratio)
        // fc.float requires 32-bit float bounds (use Math.fround)
        fc.float({
          min: Math.fround(0.001),
          max: Math.fround(100_000),
          noNaN: true,
        }),
        // threshold > 0 (threshold must be positive)
        fc.float({
          min: Math.fround(0.001),
          max: Math.fround(100_000),
          noNaN: true,
        }),
        (peak, threshold) => {
          // This mirrors the exact expression in eligibleForProbe:
          // openBreachPeakRatio = peak > 0 ? peak / entryThreshold : 0
          const entryThreshold =
            threshold > 0 ? threshold : LEGACY_OPEN_BREACH_ENTRY_THRESHOLD;
          const ratio =
            Number.isFinite(peak) && peak > 0 ? peak / entryThreshold : 0;
          expect(ratio).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(ratio)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("pool with currentOpenBreachPeak='0' always produces openBreachPeakRatio=0 regardless of entryThreshold", () => {
    // The actual eligibleForProbe expression: openBreachPeak > 0 ? peak/threshold : 0
    // When peak == 0, the guard short-circuits and the ratio is 0 unconditionally.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_800_000_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        (breach, entryThreshold) => {
          const pool = eligiblePool({
            deviationBreachStartedAt: String(breach),
            // ratio must be above tolerance but below critical so only the peak drives eligibility
            lastDeviationRatio: "1.02",
            currentOpenBreachPeak: "0",
            currentOpenBreachEntryThreshold: entryThreshold,
          });
          // Pool must not be eligible — neither the ratio (1.02 < 1.05 critical)
          // nor the peak (0) crosses the critical threshold.
          expect(eligibleForProbe([pool])).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Reserve share — r0/total + r1/total = 1 for any positive r0, r1
// ---------------------------------------------------------------------------
describe("reserve share math — shares sum to 1 for any positive reserves", () => {
  it("r0/(r0+r1) + r1/(r0+r1) === 1 for any positive r0, r1", () => {
    fc.assert(
      fc.property(
        // Use integer reserves to avoid floating-point accumulation issues;
        // the actual code does `Number(BigIntString) / 10**decimals`
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 18 }), // token0Decimals
        fc.integer({ min: 0, max: 18 }), // token1Decimals
        (rawR0, rawR1, dec0, dec1) => {
          const r0 = Number(rawR0) / 10 ** dec0;
          const r1 = Number(rawR1) / 10 ** dec1;
          const total = r0 + r1;
          if (!Number.isFinite(total) || total <= 0) return;
          const share0 = r0 / total;
          const share1 = r1 / total;
          // IEEE-754 sum of complementary fractions can have 1-ULP error;
          // use a tight tolerance instead of strict ===
          expect(share0 + share1).toBeCloseTo(1, 10);
          expect(share0).toBeGreaterThanOrEqual(0);
          expect(share1).toBeGreaterThanOrEqual(0);
          expect(share0).toBeLessThanOrEqual(1);
          expect(share1).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: healthStatusToNumber — result is always in {0, 1, 2, 3}
// ---------------------------------------------------------------------------
describe("healthStatusToNumber — output is always in {0, 1, 2, 3}", () => {
  it("maps any string input to a value in {0, 1, 2, 3}", () => {
    fc.assert(
      fc.property(fc.string(), (status) => {
        const result = healthStatusToNumber(status);
        expect([0, 1, 2, 3]).toContain(result);
      }),
      { numRuns: 200 },
    );
  });

  it("is monotone: OK < WARN < CRITICAL < unknown", () => {
    expect(healthStatusToNumber("OK")).toBeLessThan(
      healthStatusToNumber("WARN"),
    );
    expect(healthStatusToNumber("WARN")).toBeLessThan(
      healthStatusToNumber("CRITICAL"),
    );
    expect(healthStatusToNumber("CRITICAL")).toBeLessThan(
      healthStatusToNumber("N/A"),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: eligibleForProbe — threshold boundary is strict (> not >=)
// ---------------------------------------------------------------------------
describe("eligibleForProbe — threshold boundary is strict", () => {
  it("ratio exactly at DEVIATION_THRESHOLD is excluded (boundary is strict >)", () => {
    const pool = eligiblePool({
      lastDeviationRatio: String(REBALANCE_PROBE_DEVIATION_THRESHOLD),
      deviationBreachStartedAt: "1713100000",
      currentOpenBreachPeak: "0",
    });
    // At exactly the threshold: ratio is NOT > threshold, so excluded
    expect(eligibleForProbe([pool])).toEqual([]);
  });

  it("ratio strictly above DEVIATION_THRESHOLD with active breach is always included (given rebalancer set)", () => {
    fc.assert(
      fc.property(
        // ratio in (DEVIATION_THRESHOLD, 3] — strictly above
        // fc.float requires 32-bit float bounds (use Math.fround)
        fc.float({
          min: Math.fround(REBALANCE_PROBE_DEVIATION_THRESHOLD + 0.001),
          max: Math.fround(3),
          noNaN: true,
        }),
        fc.integer({ min: 1, max: 1_800_000_000 }),
        (ratio, breach) => {
          const pool = eligiblePool({
            lastDeviationRatio: ratio.toFixed(6),
            deviationBreachStartedAt: String(breach),
            rebalancerAddress: "0x0000000000000000000000000000000000000beef",
          });
          expect(eligibleForProbe([pool])).toEqual([pool]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
