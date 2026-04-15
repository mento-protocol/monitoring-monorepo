/// <reference types="mocha" />
import { assert } from "chai";
import {
  isInDeviationBreach,
  nextDeviationBreachStartedAt,
  DEFAULT_ORACLE_FIELDS,
} from "../src/pool";
import type { Pool } from "generated";

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
    oracleOk: true,
    rebalanceThreshold: 5000,
    createdAtBlock: 0n,
    createdAtTimestamp: 0n,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
    ...overrides,
  };
}

describe("isInDeviationBreach", () => {
  it("false when priceDifference < threshold", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 4999n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("false at exact threshold (strict >; exactly-at-threshold stays WARN per computeHealthStatus)", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 5000n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("true when priceDifference > threshold", () => {
    assert.isTrue(
      isInDeviationBreach(
        makePool({ priceDifference: 7500n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("false for virtual pools regardless of deviation", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({
          source: "virtual_pool_factory",
          priceDifference: 10_000n,
          rebalanceThreshold: 5000,
        }),
      ),
    );
  });

  it("falls back to threshold=10000 when rebalanceThreshold === 0", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 10_000n, rebalanceThreshold: 0 }),
      ),
    );
    assert.isTrue(
      isInDeviationBreach(
        makePool({ priceDifference: 10_001n, rebalanceThreshold: 0 }),
      ),
    );
  });
});

describe("nextDeviationBreachStartedAt", () => {
  const TS = 1_700_000_000n;

  it("OK → CRITICAL sets to blockTimestamp", () => {
    const prev = makePool({ priceDifference: 1000n });
    const next = makePool({ priceDifference: 6000n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), TS);
  });

  it("CRITICAL → CRITICAL preserves original startedAt", () => {
    const origStart = 1_600_000_000n;
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: origStart,
    });
    const next = makePool({ priceDifference: 7500n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), origStart);
  });

  it("CRITICAL → WARN resets to 0n", () => {
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: 1_600_000_000n,
    });
    const next = makePool({ priceDifference: 4500n }); // d = 0.9 → WARN
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), 0n);
  });

  it("CRITICAL → OK resets to 0n", () => {
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: 1_600_000_000n,
    });
    const next = makePool({ priceDifference: 1000n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), 0n);
  });

  it("WARN → CRITICAL sets (WARN is not a breach)", () => {
    const prev = makePool({
      priceDifference: 4500n, // d = 0.9 → WARN, not breached
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({ priceDifference: 5100n }); // breached
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), TS);
  });

  it("oracle-stale does NOT clear an active deviation breach", () => {
    // isInDeviationBreach is intentionally price-only. A pool that is in breach
    // should keep its start timestamp even if the oracle goes stale.
    const origStart = 1_600_000_000n;
    const prev = makePool({
      oracleOk: true,
      priceDifference: 6000n,
      deviationBreachStartedAt: origStart,
    });
    const next = makePool({
      oracleOk: false, // oracle went stale
      priceDifference: 6000n, // still breached
    });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), origStart);
  });

  it("self-heals when prev is breached but deviationBreachStartedAt === 0n", () => {
    // Partial restore / pre-backfill scenario: a row lands with
    // priceDifference >= threshold but deviationBreachStartedAt = 0n. Instead
    // of preserving the bad sentinel forever, adopt the current block time.
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({ priceDifference: 6500n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), TS);
  });

  it("first event (prev undefined) already breached sets to blockTimestamp", () => {
    const next = makePool({ priceDifference: 6000n });
    assert.equal(nextDeviationBreachStartedAt(undefined, next, TS), TS);
  });

  it("first event (prev undefined) not breached stays 0n", () => {
    const next = makePool({ priceDifference: 1000n });
    assert.equal(nextDeviationBreachStartedAt(undefined, next, TS), 0n);
  });

  it("re-entry CRITICAL → OK → CRITICAL starts a fresh timestamp", () => {
    const firstStart = 1_600_000_000n;

    // In breach
    const s1 = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: firstStart,
    });
    // Exit to OK
    const s2 = makePool({ priceDifference: 1000n });
    const afterExit = nextDeviationBreachStartedAt(s1, s2, TS);
    assert.equal(afterExit, 0n);

    // Re-enter at later timestamp
    const s2Updated = { ...s2, deviationBreachStartedAt: afterExit };
    const s3 = makePool({ priceDifference: 7500n });
    const TS2 = TS + 3600n;
    const afterReentry = nextDeviationBreachStartedAt(s2Updated, s3, TS2);
    assert.equal(afterReentry, TS2);
    assert.notEqual(afterReentry, firstStart);
  });

  it("virtual pools always stay at 0n", () => {
    const prev = makePool({ source: "virtual_pool_factory" });
    const next = makePool({
      source: "virtual_pool_factory",
      priceDifference: 10_000n,
    });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), 0n);
  });
});
