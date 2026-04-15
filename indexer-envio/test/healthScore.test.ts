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
    // No-data sentinel: "-1" for ratio, "0.000000" for binary (not healthy).
    // hasHealthData=false is the canonical gate; check it before using values.
    assert.equal(result.deviationRatio, "-1");
    assert.equal(result.healthBinaryValue, "0.000000");
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
  it("skips accumulator update when hasHealthData is false (rebalanceThreshold=0)", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 100n,
      healthBinarySeconds: 100n,
      hasHealthData: true,
      oracleExpiry: 300n,
    });

    const { snapshotFields, poolUpdate } = recordHealthSample(
      pool,
      5000n, // priceDifference
      0, // rebalanceThreshold = 0 → no valid data
      1200n, // blockTimestamp
    );

    // Snapshot should be flagged as no-data
    assert.isFalse(snapshotFields.hasHealthData);
    // Pool accumulators should NOT be modified (except timestamp advances)
    assert.equal(poolUpdate.healthTotalSeconds, 100n);
    assert.equal(poolUpdate.healthBinarySeconds, 100n);
    // Timestamp advances to prevent next valid sample from accumulating gap
    assert.equal(poolUpdate.lastOracleSnapshotTimestamp, 1200n);
    // lastDeviationRatio set to sentinel so next valid sample skips gap
    assert.equal(poolUpdate.lastDeviationRatio, "-1");
    assert.isTrue(poolUpdate.hasHealthData); // preserves existing state
  });

  it("valid -> no-data -> valid: excludes no-data gap from both numerator and denominator", () => {
    // Step 1: healthy pool at t=1000
    const pool1 = makePool({
      lastOracleSnapshotTimestamp: 1000n,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 100n,
      healthBinarySeconds: 100n,
      hasHealthData: true,
      oracleExpiry: 300n,
    });

    // Step 2: no-data event at t=1200 (rebalanceThreshold=0)
    const { poolUpdate: afterNoData } = recordHealthSample(
      pool1,
      5000n,
      0, // no valid data
      1200n,
    );

    // Accumulators unchanged, but timestamp advanced and ratio is sentinel
    assert.equal(afterNoData.healthTotalSeconds, 100n);
    assert.equal(afterNoData.healthBinarySeconds, 100n);
    assert.equal(afterNoData.lastOracleSnapshotTimestamp, 1200n);
    assert.equal(afterNoData.lastDeviationRatio, "-1");

    // Step 3: valid healthy event at t=1500 — the 300s gap should be excluded
    const pool2 = makePool({
      ...afterNoData,
      oracleExpiry: 300n,
    });
    const { poolUpdate: afterValid } = recordHealthSample(
      pool2,
      2500n, // healthy (d=0.5)
      5000, // rebalanceThreshold=5000
      1500n,
    );

    // The 300s gap (1200→1500) should NOT be added to totalSeconds
    assert.equal(afterValid.healthTotalSeconds, 100n);
    assert.equal(afterValid.healthBinarySeconds, 100n);
    assert.equal(afterValid.lastOracleSnapshotTimestamp, 1500n);
    assert.equal(afterValid.lastDeviationRatio, "0.500000");
  });

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

// ---------------------------------------------------------------------------
// Weekend exclusion (matches UI computeBinaryHealthWindow)
// ---------------------------------------------------------------------------

/** Seconds since epoch for a UTC date. */
function utcSec(
  year: number,
  monthIdx: number, // 0-based
  day: number,
  hour: number,
  minute = 0,
): bigint {
  return BigInt(Math.floor(Date.UTC(year, monthIdx, day, hour, minute) / 1000));
}

describe("updateHealthAccumulators (weekend-aware)", () => {
  // Anchor test dates in 2026-03 (same week as UI tests). 2026-03-13 is
  // Friday, 2026-03-16 is Monday.
  const FRI_20 = utcSec(2026, 2, 13, 20, 0); // Fri 20:00 UTC
  const FRI_22 = utcSec(2026, 2, 13, 22, 0); // Fri 22:00 UTC (inside weekend)
  const SAT_12 = utcSec(2026, 2, 14, 12, 0); // Sat 12:00 UTC (inside weekend)
  const MON_09 = utcSec(2026, 2, 16, 9, 0); // Mon 09:00 UTC
  const TUE_12 = utcSec(2026, 2, 17, 12, 0); // Tue 12:00 UTC

  it("healthy across a weekend: duration counts only trading-seconds", () => {
    // Pool healthy at Fri 20:00, next event Mon 09:00.
    // Wall-clock = 61h. Trading-seconds = 1h Fri (20:00→21:00) + 10h Mon
    // (Sun 23:00→Mon 09:00) = 11h = 39600s.
    // Carry = min(39600, 300) = 300s healthy. Rest (39300s) is stale.
    const pool = makePool({
      lastOracleSnapshotTimestamp: FRI_20,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, MON_09, "0.500000");
    assert.equal(result.healthTotalSeconds, 39600n);
    assert.equal(result.healthBinarySeconds, 300n);
    assert.equal(result.lastOracleSnapshotTimestamp, MON_09);
  });

  it("weekend-only gap: no accumulator change, timestamp advances", () => {
    // Fri 22:00 → Sat 12:00 is entirely inside the weekend window.
    // trading-seconds = 0 → early return, no change to accumulators.
    const pool = makePool({
      lastOracleSnapshotTimestamp: FRI_22,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 1000n,
      healthBinarySeconds: 1000n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, SAT_12, "0.500000");
    assert.equal(result.healthTotalSeconds, 1000n);
    assert.equal(result.healthBinarySeconds, 1000n);
    assert.equal(result.lastOracleSnapshotTimestamp, SAT_12);
    assert.equal(result.lastDeviationRatio, "0.500000");
  });

  it("weekday-only interval: unaffected by weekend arithmetic", () => {
    // Mon 09:00 → Tue 12:00 = 27h = 97200s, all trading.
    const pool = makePool({
      lastOracleSnapshotTimestamp: MON_09,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, TUE_12, "0.500000");
    assert.equal(result.healthTotalSeconds, 97200n);
    assert.equal(result.healthBinarySeconds, 300n); // carry capped at freshness
  });

  it("same-block event still no-ops after weekend change (regression)", () => {
    const pool = makePool({
      lastOracleSnapshotTimestamp: FRI_20,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 50n,
      healthBinarySeconds: 50n,
      oracleExpiry: 300n,
    });
    const result = updateHealthAccumulators(pool, FRI_20, "0.800000");
    assert.equal(result.healthTotalSeconds, 50n);
    assert.equal(result.healthBinarySeconds, 50n);
    assert.equal(result.lastOracleSnapshotTimestamp, FRI_20);
    assert.equal(result.lastDeviationRatio, "0.800000");
  });

  it("healthy at Fri 20:45 with 1h freshness, next event Mon 10:00 → carry measured in trading-seconds within wall-clock freshness window", () => {
    // Snap Fri 20:45 healthy, freshness 3600s (wall-clock). freshnessEnd = Fri 21:45
    // wall-clock, but only Fri 20:45→21:00 (15 min = 900s) is trading time.
    // Next event Mon 10:00 → gap = 11h15m trading-seconds = 40500s.
    // carrySeconds = tradingSecondsInRange(Fri20:45, Fri21:45) = 900s.
    // stalePart = 40500 - 900 = 39600s.
    // healthBinarySeconds += 900 (not 3600 — that would be the old broken math).
    const FRI_2045 = utcSec(2026, 2, 13, 20, 45);
    const MON_10 = utcSec(2026, 2, 16, 10, 0);
    const pool = makePool({
      lastOracleSnapshotTimestamp: FRI_2045,
      lastDeviationRatio: "0.500000",
      healthTotalSeconds: 0n,
      healthBinarySeconds: 0n,
      oracleExpiry: 3600n,
    });
    const result = updateHealthAccumulators(pool, MON_10, "0.500000");
    assert.equal(result.healthTotalSeconds, 40500n);
    assert.equal(result.healthBinarySeconds, 900n);
  });
});
