/// <reference types="mocha" />
import { assert } from "chai";
import type { Pool } from "generated";
import { DEFAULT_ORACLE_FIELDS, computeHealthStatus } from "../src/pool";

// ---------------------------------------------------------------------------
// Cross-package parity: these cases MUST match the assertions in
// `ui-dashboard/src/lib/__tests__/health.test.ts`. The indexer and the UI
// compute pool health independently, and any drift between them produces
// a user-visible divergence (indexed badge vs live-recomputed badge).
//
// If you change `computeHealthStatus` in either package, mirror the change
// and update the parity case here so the invariant can't slip silently.
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

  it("returns 'CRITICAL' when oracleOk is false", () => {
    const pool = makePool({ oracleOk: false, priceDifference: 0n });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("returns 'OK' when devRatio is below 0.8", () => {
    // 3000/5000 = 0.6
    const pool = makePool({ priceDifference: 3000n });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("returns 'WARN' when 0.8 <= devRatio < 1.0", () => {
    // 4500/5000 = 0.9
    const pool = makePool({ priceDifference: 4500n });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("returns 'WARN' (not 'CRITICAL') when devRatio is exactly 1.0", () => {
    // 5000/5000 = 1.0 — sitting right at the threshold stays WARN.
    const pool = makePool({ priceDifference: 5000n });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("returns 'CRITICAL' when devRatio > 1.0 and no recent rebalance", () => {
    // 8000/5000 = 1.6, no lastRebalancedAt anchor.
    const pool = makePool({ priceDifference: 8000n });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("stays 'WARN' during the 1h grace window after a rebalance", () => {
    // Breach present, but a rebalance landed 30min ago.
    const pool = makePool({
      priceDifference: 8000n,
      lastRebalancedAt: NOW - 1800n, // 30min ago
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("escalates to 'CRITICAL' once the breach outlasts the grace window", () => {
    const pool = makePool({
      priceDifference: 8000n,
      lastRebalancedAt: NOW - 2n * 3600n, // 2h ago
    });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("treats lastRebalancedAt=0 like no rebalance ever (CRITICAL when breached)", () => {
    const pool = makePool({
      priceDifference: 8000n,
      lastRebalancedAt: 0n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("falls back to 10000 bps threshold when rebalanceThreshold is 0", () => {
    // 9000/10000 = 0.9 → WARN
    const pool = makePool({
      priceDifference: 9000n,
      rebalanceThreshold: 0,
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });
});
