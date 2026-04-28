/// <reference types="mocha" />
import assert from "node:assert/strict";
import {
  computeCooldownEndsAt,
  effectiveCooldown,
  effectiveThreshold,
  nextMedianEMA,
} from "../src/breakers.ts";

const FIXED_1 = 10n ** 24n;

describe("nextMedianEMA — Fixidity formula mirroring MedianDeltaBreaker.shouldTrigger", () => {
  it("seeds EMA with currentMedian when previousEMA is 0 (contract line 182-186)", () => {
    const currentMedian = 1_171_560_280_196_965_000_000_000n; // 1.171… Fixidity
    const result = nextMedianEMA(currentMedian, 0n, 5n * 10n ** 21n /* 0.5% */);
    assert.equal(result, currentMedian);
  });

  it("seeds with currentMedian even if smoothingFactor is 0 (default-smoothing branch)", () => {
    // Smoothing 0 falls back to fixed1 (1e24) inside the helper; with EMA 0,
    // the seed branch fires regardless of smoothing.
    const currentMedian = 12345n;
    assert.equal(nextMedianEMA(currentMedian, 0n, 0n), 12345n);
  });

  it("blends current median into EMA at the configured smoothing weight", () => {
    // With smoothing 0.5% (production value), 99.5% old + 0.5% new.
    const sf = 5n * 10n ** 21n; // 0.5% Fixidity
    const previous = 1_000_000n * FIXED_1; // arbitrary EMA
    const next = 1_010_000n * FIXED_1; // 1% jump
    const result = nextMedianEMA(next, previous, sf);
    // Expected: (1_010_000 * 0.005 + 1_000_000 * 0.995) * FIXED_1
    //         = (5050 + 995_000) * FIXED_1
    //         = 1_000_050 * FIXED_1
    assert.equal(result, 1_000_050n * FIXED_1);
  });

  it("treats smoothing factor 1.0 as 'replace EMA with currentMedian'", () => {
    const sf = FIXED_1; // 100% weight on new sample
    const previous = 100n;
    const current = 200n;
    assert.equal(nextMedianEMA(current, previous, sf), 200n);
  });
});

describe("computeCooldownEndsAt", () => {
  it("returns 0 when cooldown is 0 (manual reset only)", () => {
    assert.equal(computeCooldownEndsAt(123n, 0n), 0n);
  });

  it("returns lastStatusUpdatedAt + cooldownTime", () => {
    assert.equal(computeCooldownEndsAt(1_700_000_000n, 900n), 1_700_000_900n);
  });
});

describe("effectiveCooldown / effectiveThreshold — sentinel-0 inheritance", () => {
  const breaker = {
    defaultCooldownTime: 900n,
    defaultRateChangeThreshold: 4n * 10n ** 22n, // 4%
  };

  it("uses per-feed override when > 0", () => {
    assert.equal(effectiveCooldown(breaker, 60n), 60n);
  });

  it("falls back to default when per-feed is 0", () => {
    assert.equal(effectiveCooldown(breaker, 0n), 900n);
  });

  it("threshold inherits the same way", () => {
    assert.equal(effectiveThreshold(breaker, 0n), 4n * 10n ** 22n);
    assert.equal(effectiveThreshold(breaker, 1n * 10n ** 22n), 1n * 10n ** 22n);
  });
});
