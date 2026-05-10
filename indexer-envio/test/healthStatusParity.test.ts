/// <reference types="mocha" />
import { assert } from "chai";
import { computeHealthStatus } from "../src/pool";
import { makePool } from "./helpers/makePool";

// ---------------------------------------------------------------------------
// Cross-package parity for the DEVIATION + TOLERANCE + GRACE branches of
// computeHealthStatus only. The indexer and the UI diverge intentionally
// on other branches (oracle-staleness via wall-clock vs. the indexed
// `oracleOk` flag, weekend reclassification at render time, per-chain
// expiry fallbacks) — see the pool.ts header comment for the full list.
//
// Cases in this file MUST match the corresponding assertions in
// `ui-dashboard/src/lib/__tests__/health.test.ts`. If you change the
// devRatio tolerance/critical boundaries or grace-window behaviour in either
// package, mirror the change and update the case here so the shared
// invariant can't slip silently. Adding a staleness / weekend / chain-
// fallback parity test would require the indexer to actually mirror those
// branches first.
// ---------------------------------------------------------------------------

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
    // 5000/5000 = 1.0 — at-threshold is healthy and inside tolerance.
    const pool = makePool({ priceDifference: 5000n });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("stays 'OK' inside the 1% tolerance dead zone (devRatio = 1.005)", () => {
    const pool = makePool({ priceDifference: 5025n });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("stays 'OK' at exactly the tolerance line — strict `>` (devRatio = 1.01)", () => {
    const pool = makePool({ priceDifference: 5050n });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("returns 'WARN' just above tolerance regardless of duration (devRatio = 1.012)", () => {
    // Long anchor (2h) must NOT escalate this — magnitude < 1.05 means
    // duration is irrelevant for CRITICAL.
    const pool = makePool({
      priceDifference: 5060n,
      deviationBreachStartedAt: NOW - 2n * 3600n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("stays 'WARN' at exactly the critical-magnitude line — strict `>` (devRatio = 1.05)", () => {
    const pool = makePool({
      priceDifference: 5250n,
      deviationBreachStartedAt: NOW - 2n * 3600n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("stays 'WARN' at devRatio = 1.05 within the grace window (sub-grace boundary)", () => {
    // Mirror of the past-grace 1.05 case above, this time with a 30m anchor.
    // Both magnitude and duration gates must hold for CRITICAL — pin the
    // sub-grace boundary so a regression that moved the magnitude check
    // inside the grace branch can't slip past parity.
    const pool = makePool({
      priceDifference: 5250n,
      deviationBreachStartedAt: NOW - 1800n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("returns 'WARN' on a fresh large breach with no breach-start anchor yet", () => {
    // 8000/5000 = 1.6, deviationBreachStartedAt not yet populated.
    const pool = makePool({ priceDifference: 8000n });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("stays 'WARN' while a >5% breach is within the 1h grace window", () => {
    const pool = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: NOW - 1800n, // 30min ago
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("stays 'WARN' one second before the grace boundary (3599s)", () => {
    // Mirror of the UI boundary test: grace uses strict `<`, so 3599s is
    // still in-grace on both packages. Pinned here to prevent a silent
    // `<`/`<=` drift between indexer and dashboard.
    const pool = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: NOW - 3599n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("flips to 'CRITICAL' at exactly the 1h grace boundary (3600s)", () => {
    const pool = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: NOW - 3600n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("escalates to 'CRITICAL' once the breach outlasts the grace window", () => {
    const pool = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: NOW - 2n * 3600n, // 2h ago
    });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("returns 'WARN' when the breach anchor is 0n (indexer hasn't populated yet)", () => {
    // Mirror of the UI's null-anchor test: when there's no anchor, both
    // packages should stay at WARN instead of jumping straight to
    // CRITICAL. The indexer stores 0n (not null) when the field is unset;
    // this exercises that path.
    const pool = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: 0n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "WARN");
  });

  it("falls back to 10000 bps threshold when rebalanceThreshold is 0 and unknown", () => {
    // 9000/10000 = 0.9 → still OK. `rebalanceThresholdsKnown=false` (default)
    // means the indexer hasn't read the on-chain value yet, so we under-bound
    // to keep breach detection safe.
    const pool = makePool({
      priceDifference: 9000n,
      rebalanceThreshold: 0,
      rebalanceThresholdsKnown: false,
    });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("dual-sentinel: known-zero rebalanceThreshold stays OK at any deviation", () => {
    // `rebalanceThreshold=0` AND `rebalanceThresholdsKnown=true` is governance
    // configuring the pool to never rebalance. A 200% priceDifference must
    // still resolve to OK. Otherwise a never-rebalance pool would
    // CRITICAL-spam every event.
    const pool = makePool({
      priceDifference: 20_000n, // 200% — well past the unknown-zero 10000 fallback
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 0,
      rebalanceThresholdsKnown: true,
    });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("dual-sentinel: known-zero short-circuits even past the 1e12 effectiveThreshold cushion", () => {
    // Past-grace anchor + priceDifference = 2e12 would trip the predicate
    // if it relied on the 1e12 cushion alone (1e12 * 1.01 < 2e12). The
    // explicit `isNeverRebalance` short-circuit must keep this OK regardless
    // of magnitude. Extreme reserve skew can theoretically push
    // priceDifference past the cushion; this pins that the short-circuit
    // wins over the cushion at that boundary.
    const pool = makePool({
      priceDifference: 2n * 10n ** 12n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 0,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: NOW - 2n * 3600n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "OK");
  });

  it("dual-sentinel: unknown-zero with high deviation flows into WARN/CRITICAL via 10000 fallback", () => {
    // Same priceDifference as above, but unknown-zero — caller should NOT
    // treat this as never-rebalance. 20000/10000 = 2.0, well above the 1.05
    // critical magnitude line. Past the 1h grace → CRITICAL. Pinned so a
    // regression that collapsed both branches to 1e12 would flip this to OK.
    const pool = makePool({
      priceDifference: 20_000n,
      rebalanceThreshold: 0,
      rebalanceThresholdsKnown: false,
      deviationBreachStartedAt: NOW - 2n * 3600n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });

  it("asymmetric (above=0, below>0) does NOT count as never-rebalance", () => {
    // Active `rebalanceThreshold` alone can't disambiguate: an asymmetric
    // pool whose reservePrice currently sits on the above side persists
    // `rebalanceThreshold=0` but the pool DOES rebalance on the below
    // side. A regression that classifies this as never-rebalance would
    // suppress all deviation alerts. Pinned: high diff (12000bps,
    // > 1.05 * 10000 fallback) past the 1h grace → CRITICAL.
    const pool = makePool({
      priceDifference: 12_000n,
      rebalanceThreshold: 0, // active side picked above (=0)
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300, // configured below side — pool DOES rebalance
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: NOW - 2n * 3600n,
    });
    assert.equal(computeHealthStatus(pool, NOW), "CRITICAL");
  });
});
