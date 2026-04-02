/// <reference types="mocha" />
import { assert } from "chai";
import {
  computeHealthSnapshotFields,
  updateHealthAccumulators,
  recordHealthSample,
} from "../src/healthScore";
import type { Pool } from "generated";
import { DEFAULT_ORACLE_FIELDS } from "../src/pool";

// ---------------------------------------------------------------------------
// Factory for minimal Pool entities used in accumulator tests
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
    createdAtBlock: 0n,
    createdAtTimestamp: 0n,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeHealthSnapshotFields
// ---------------------------------------------------------------------------

describe("computeHealthSnapshotFields", () => {
  it("returns healthy for d = 0 (perfect balance)", () => {
    const result = computeHealthSnapshotFields(0n, 5000);
    assert.equal(result.deviationRatio, "0.000000");
    assert.equal(result.healthBinaryValue, "1.000000");
    assert.isTrue(result.hasHealthData);
  });

  it("returns healthy for d < 1.0", () => {
    // priceDifference=2500, threshold=5000 → d = 0.5
    const result = computeHealthSnapshotFields(2500n, 5000);
    assert.equal(result.deviationRatio, "0.500000");
    assert.equal(result.healthBinaryValue, "1.000000");
    assert.isTrue(result.hasHealthData);
  });

  it("returns healthy at exact threshold (d = 1.0)", () => {
    const result = computeHealthSnapshotFields(5000n, 5000);
    assert.equal(result.deviationRatio, "1.000000");
    assert.equal(result.healthBinaryValue, "1.000000");
    assert.isTrue(result.hasHealthData);
  });

  it("returns unhealthy for d > 1.0", () => {
    // priceDifference=6000, threshold=5000 → d = 1.2
    const result = computeHealthSnapshotFields(6000n, 5000);
    assert.equal(result.deviationRatio, "1.200000");
    assert.equal(result.healthBinaryValue, "0.000000");
    assert.isTrue(result.hasHealthData);
  });

  it("returns unhealthy for large deviation (d >> 1)", () => {
    // priceDifference=100000, threshold=5000 → d = 20
    const result = computeHealthSnapshotFields(100000n, 5000);
    assert.equal(result.deviationRatio, "20.000000");
    assert.equal(result.healthBinaryValue, "0.000000");
    assert.isTrue(result.hasHealthData);
  });

  it("handles rebalanceThreshold = 0 (edge case)", () => {
    const result = computeHealthSnapshotFields(5000n, 0);
    assert.equal(result.deviationRatio, "0.000000");
    assert.equal(result.healthBinaryValue, "1.000000");
    assert.isFalse(result.hasHealthData);
  });

  it("handles negative rebalanceThreshold gracefully", () => {
    const result = computeHealthSnapshotFields(5000n, -1);
    assert.isFalse(result.hasHealthData);
  });

  it("tiny over-threshold (d = 1.000001) is unhealthy", () => {
    // priceDifference=5001, threshold=5000 → d = 1.0002
    const result = computeHealthSnapshotFields(5001n, 5000);
    assert.equal(result.healthBinaryValue, "0.000000");
  });
});

// ---------------------------------------------------------------------------
// updateHealthAccumulators
// ---------------------------------------------------------------------------

describe("updateHealthAccumulators", () => {
  it("first snapshot: no duration accumulated", () => {
    const pool = makePool();
    const result = updateHealthAccumulators(pool, 1000n, "0.500000");
    assert.equal(result.healthTotalSeconds, 0n);
    assert.equal(result.healthBinarySeconds, 0n);
    assert.equal(result.lastOracleSnapshotTimestamp, 1000n);
    assert.equal(result.lastDeviationRatio, "0.500000");
    assert.isTrue(result.hasHealthData);
  });

  it("second snapshot: healthy interval accumulated", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000", // healthy
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, 1100n, "0.600000");
    // Duration = 100s, within freshnessLimit (300s)
    assert.equal(result.healthTotalSeconds, 100n);
    assert.equal(result.healthBinarySeconds, 100n); // previous was healthy
    assert.equal(result.lastOracleSnapshotTimestamp, 1100n);
  });

  it("unhealthy previous interval: no binary seconds added", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "1.500000", // unhealthy (d > 1.0)
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, 1100n, "0.500000");
    assert.equal(result.healthTotalSeconds, 100n);
    assert.equal(result.healthBinarySeconds, 0n); // previous was unhealthy
  });

  it("gap exceeding freshness limit: splits carry + stale", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000", // healthy
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 300n,
    });
    // Gap = 1000s, freshnessLimit = 300s
    // Carry = 300s (healthy), Stale = 700s (unhealthy)
    const result = updateHealthAccumulators(pool, 2000n, "0.500000");
    assert.equal(result.healthTotalSeconds, 1000n);
    assert.equal(result.healthBinarySeconds, 300n); // only carry portion
  });

  it("stale gap with unhealthy previous: zero binary seconds", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "2.000000", // unhealthy
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, 2000n, "0.500000");
    assert.equal(result.healthTotalSeconds, 1000n);
    assert.equal(result.healthBinarySeconds, 0n); // unhealthy even in carry
  });

  it("same-timestamp events: no duration accumulated", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 50n,
      healthBinarySeconds: 50n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, 1000n, "0.800000");
    assert.equal(result.healthTotalSeconds, 50n); // unchanged
    assert.equal(result.healthBinarySeconds, 50n); // unchanged
    assert.equal(result.lastDeviationRatio, "0.800000"); // state updated
    assert.equal(result.lastOracleSnapshotTimestamp, 1000n); // keeps earlier ts
  });

  it("oracleExpiry = 0 falls back to MAX_CARRY (3600s)", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 0n, // unknown
    });
    // Gap = 7200s, MAX_CARRY = 3600s
    // Carry = 3600s (healthy), Stale = 3600s
    const result = updateHealthAccumulators(pool, 8200n, "0.500000");
    assert.equal(result.healthTotalSeconds, 7200n);
    assert.equal(result.healthBinarySeconds, 3600n);
  });

  it("oracleExpiry > MAX_CARRY: capped at 3600s", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 86400n, // 24h — unreasonably large
    });
    // Gap = 7200s, freshnessLimit = min(86400, 3600) = 3600
    const result = updateHealthAccumulators(pool, 8200n, "0.500000");
    assert.equal(result.healthTotalSeconds, 7200n);
    assert.equal(result.healthBinarySeconds, 3600n);
  });

  it("accumulates across multiple events correctly", () => {
    let pool = makePool({ oracleExpiry: 300n });

    // Event 1: first snapshot at t=1000, healthy
    let update = updateHealthAccumulators(pool, 1000n, "0.500000");
    pool = makePool({ ...pool, ...update, oracleExpiry: 300n });

    // Event 2: t=1100, still healthy (gap=100s < 300s carry)
    update = updateHealthAccumulators(pool, 1100n, "0.800000");
    pool = makePool({ ...pool, ...update, oracleExpiry: 300n });
    assert.equal(pool.healthTotalSeconds, 100n);
    assert.equal(pool.healthBinarySeconds, 100n);

    // Event 3: t=1200, unhealthy now (gap=100s)
    update = updateHealthAccumulators(pool, 1200n, "1.500000");
    pool = makePool({ ...pool, ...update, oracleExpiry: 300n });
    assert.equal(pool.healthTotalSeconds, 200n);
    assert.equal(pool.healthBinarySeconds, 200n); // prev was healthy

    // Event 4: t=1300, healthy again (gap=100s, prev was unhealthy)
    update = updateHealthAccumulators(pool, 1300n, "0.500000");
    pool = makePool({ ...pool, ...update, oracleExpiry: 300n });
    assert.equal(pool.healthTotalSeconds, 300n);
    assert.equal(pool.healthBinarySeconds, 200n); // prev was unhealthy, +0
  });
});

// ---------------------------------------------------------------------------
// recordHealthSample (integration of both functions)
// ---------------------------------------------------------------------------

describe("recordHealthSample", () => {
  it("combines snapshot fields and pool update", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 300n,
    });

    const { snapshotFields, poolUpdate } = recordHealthSample(
      pool,
      2500n, // priceDifference
      5000, // rebalanceThreshold
      1100n, // blockTimestamp
    );

    // Snapshot fields
    assert.equal(snapshotFields.deviationRatio, "0.500000");
    assert.equal(snapshotFields.healthBinaryValue, "1.000000");
    assert.isTrue(snapshotFields.hasHealthData);

    // Pool update
    assert.equal(poolUpdate.healthTotalSeconds, 100n);
    assert.equal(poolUpdate.healthBinarySeconds, 100n);
    assert.equal(poolUpdate.lastOracleSnapshotTimestamp, 1100n);
    assert.equal(poolUpdate.lastDeviationRatio, "0.500000");
  });
});
