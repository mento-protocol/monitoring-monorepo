/// <reference types="mocha" />
import { assert } from "chai";
import type { Pool } from "generated";
import { DEFAULT_ORACLE_FIELDS, computeHealthStatus } from "../src/pool";

// ---------------------------------------------------------------------------
// Cross-package parity for the DEVIATION + GRACE branch of
// computeHealthStatus only. The indexer and the UI diverge intentionally
// on other branches (oracle-staleness via wall-clock vs. the indexed
// `oracleOk` flag, weekend reclassification at render time, per-chain
// expiry fallbacks) — see the pool.ts header comment for the full list.
//
// Cases in this file MUST match the corresponding assertions in
// `ui-dashboard/src/lib/__tests__/health.test.ts`. If you change the
// devRatio boundary or grace-window behaviour in either package, mirror
// the change and update the case here so the shared invariant can't slip
// silently. Adding a staleness / weekend / chain-fallback parity test
// would require the indexer to actually mirror those branches first.
// ---------------------------------------------------------------------------

function makePool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "42220-0xtest",
    chainId: 42220,
    token0: "0xtok0",
    token1: "0xtok1",
    token0Decimals: 18,
    token1Decimals: 18,
    source: "fpmm_factory",
    reserves0: 0n,
    reserves1: 0n,
    swapCount: 0,
    notionalVolume0: 0n,
    notionalVolume1: 0n,
    rebalanceCount: 0,
    ...DEFAULT_ORACLE_FIELDS,
    oracleOk: true, // default to fresh so parity tests focus on the dev-ratio path
    rebalanceThreshold: 5000,
    createdAtBlock: 0n,
    createdAtTimestamp: 0n,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
    ...overrides,
  };
}

const NOW = 1_700_000_000n;

describe("computeHealthStatus — parity with ui-dashboard", () => {
  it("returns 'N/A' for virtual pools", () => {
    const pool = makePool({ source: "virtual_pool_factory", oracleOk: false });
    assert.equal(computeHealthStatus(pool, NOW), "N/A");
  });

  it("returns 'N/A' for any source string containing 'virtual' (substring match)", () => {
    // Dashboard uses `source.includes("virtual")` — the indexer mirrors
    // that so namespaced variants (e.g. "virtual_pool_bridge") stay
    // N/A rather than flowing into the deviation code path.
    const pool = makePool({
      source: "virtual_pool_bridge_variant",
      oracleOk: false,
    });
    assert.equal(computeHealthStatus(pool, NOW), "N/A");
  });

  it("returns 'OK' when devRatio is well below 1.0", () => {
    // 3000/5000 = 0.6
    const pool = makePool({ priceDifference: 3000n });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("stays 'OK' when the pool is close to but still under the threshold", () => {
    // 4500/5000 = 0.9 — close is not actionable, so no warning.
    const pool = makePool({ priceDifference: 4500n });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("stays 'OK' when devRatio is exactly 1.0", () => {
    // 5000/5000 = 1.0 — at-threshold is still healthy.
    const pool = makePool({ priceDifference: 5000n });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("returns 'WARN' on a fresh breach with no breach-start anchor yet", () => {
    // 8000/5000 = 1.6, deviationBreachStartedAt not yet populated.
    const pool = makePool({ priceDifference: 8000n });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("stays 'WARN' while the breach is within the 1h grace window", () => {
    const pool = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: NOW - 1800n, // 30min ago
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("escalates to 'CRITICAL' once the breach outlasts the grace window", () => {
    const pool = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: NOW - 2n * 3600n, // 2h ago
    });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("falls back to 10000 bps threshold when rebalanceThreshold is 0", () => {
    // 9000/10000 = 0.9 → still OK under the new rule.
    const pool = makePool({
      priceDifference: 9000n,
      rebalanceThreshold: 0,
    });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });
});
