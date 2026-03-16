/// <reference types="mocha" />
import { strict as assert } from "assert";
import { computePriceDifference } from "../src/EventHandlers";

const SCALE = 10n ** 24n;

// Helper: build a pool input for computePriceDifference.
function pool(opts: {
  reserves0: bigint;
  reserves1: bigint;
  oraclePrice: bigint;
  invertRateFeed?: boolean;
  token0Decimals?: number;
  token1Decimals?: number;
}) {
  return {
    token0Decimals: 18,
    token1Decimals: 18,
    invertRateFeed: false,
    ...opts,
  };
}

describe("computePriceDifference", () => {
  // -----------------------------------------------------------------------
  // Contract-verified scenario: pool 0xb0a... on Monad
  // getRebalancingState returns priceDifference = 3333 bps
  // reservePrice = reserve1 / reserve0 = 40017/60026 ≈ 0.6668, oracle ≈ 1.0
  // (CORRECTED: FPMM uses token1/token0 direction, so we swap the constants)
  // -----------------------------------------------------------------------

  const ORACLE_PRICE = 999_992_860_000_000_000_000_000n; // ≈ 1.0 at 24dp
  const R0 = 60_025_803_785_000_000_000_000n; // ~60k (18dp) — was R1_NON
  const R1 = 40_017_373_654_286_326_120_236n; // ~40k (18dp) — was R0_USDM

  it("non-inverted pool — matches contract priceDifference (3333 bps)", () => {
    // reserve1/reserve0 = 40017/60026 ≈ 0.6668, oracle ≈ 1.0
    // deviation = |0.6668 - 1.0| / 1.0 ≈ 33.33% ≈ 3333 bps
    const pd = computePriceDifference(
      pool({
        reserves0: R0,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
      }),
    );
    assert.equal(pd, 3333n);
  });

  it("invertRateFeed=true — inverts oracle, different result", () => {
    // With invertRateFeed, the contract compares reserve1/reserve0 against 1/oracle.
    // reserve1/reserve0 = 40017/60026 ≈ 0.6668, 1/oracle ≈ 1.0 (oracle ≈ 1.0)
    // deviation ≈ |0.6668 - 1.0| / 1.0 ≈ 33.3% ≈ 3333 bps (same because oracle ≈ 1.0)
    const pd = computePriceDifference(
      pool({
        reserves0: R0,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
        invertRateFeed: true,
      }),
    );
    // With oracle ≈ 1.0, inverting gives ≈ 1.0 — same deviation
    assert.equal(pd, 3333n);
  });

  // -----------------------------------------------------------------------
  // Mixed decimals: token0 = USDC (6dp), token1 = 18dp token
  // -----------------------------------------------------------------------

  it("mixed decimals: 6dp token0, 18dp token1", () => {
    // 60k at 6dp = 60_025_803_785, 40k at 18dp
    const pd = computePriceDifference(
      pool({
        reserves0: 60_025_803_785n,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
        token0Decimals: 6,
        token1Decimals: 18,
      }),
    );
    // reserve1/reserve0 = 40k/60k ≈ 0.667, oracle ≈ 1.0, deviation ≈ 33.3%
    assert.equal(pd, 3333n);
  });

  it("mixed decimals: 18dp token0, 6dp token1", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R1,
        reserves1: 60_025_803_785n,
        oraclePrice: ORACLE_PRICE,
        token0Decimals: 18,
        token1Decimals: 6,
      }),
    );
    // reserve1/reserve0 = 60k/40k = 1.5, oracle ≈ 1.0, deviation ≈ 50%
    assert.ok(pd >= 4990n && pd <= 5010n, `expected ~5000 bps, got ${pd}`);
  });

  // -----------------------------------------------------------------------
  // GBP/USD style: oracle ≈ 1.34, deviation ≈ 33.6%
  // -----------------------------------------------------------------------

  it("non-unity oracle (GBP/USD ≈ 1.34)", () => {
    const gbpOracle = 1_340_000_000_000_000_000_000_000n; // 1.34 at 24dp
    // reserve1/reserve0 = 890/1000 = 0.89, oracle = 1.34
    // deviation = |0.89 - 1.34| / 1.34 ≈ 33.58%
    const reserves0 = 1_000_000_000_000_000_000_000n; // 1.0 (18dp)
    const reserves1 = 890_000_000_000_000_000_000n; // 0.89 (18dp)

    const pd = computePriceDifference(
      pool({
        reserves0,
        reserves1,
        oraclePrice: gbpOracle,
      }),
    );

    assert.ok(pd >= 3350n && pd <= 3360n, `expected ~3358 bps, got ${pd}`);
  });

  it("invertRateFeed=true with non-unity oracle", () => {
    const gbpOracle = 1_340_000_000_000_000_000_000_000n; // 1.34 at 24dp
    // With invertRateFeed, effective oracle = 1/1.34 ≈ 0.7463
    // reserve1/reserve0 = 890/1000 = 0.89
    // deviation = |0.89 - 0.7463| / 0.7463 ≈ 19.26%
    const reserves0 = 1_000_000_000_000_000_000_000n;
    const reserves1 = 890_000_000_000_000_000_000n;

    const pd = computePriceDifference(
      pool({
        reserves0,
        reserves1,
        oraclePrice: gbpOracle,
        invertRateFeed: true,
      }),
    );

    assert.ok(pd >= 1920n && pd <= 1930n, `expected ~1926 bps, got ${pd}`);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("returns 0 when oracle price is 0", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R0,
        reserves1: R1,
        oraclePrice: 0n,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("returns 0 when reserves are 0", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: 0n,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("extreme imbalance: very small reserve1", () => {
    // 1 wei of token1 vs 1e18 token0 — extreme imbalance, should not throw
    // reserve1/reserve0 = 1 / 1e18 → very small ratio vs oracle=1.0
    // deviation ≈ 100% (ratio ≈ 0, oracle = 1.0)
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000n,
        reserves1: 1n,
        oraclePrice: SCALE, // oracle = 1.0
      }),
    );
    assert.equal(pd, 9999n, `expected ~9999 bps (100% deviation), got ${pd}`);
  });

  it("returns 0 when >18dp normalization floors reserves to zero", () => {
    // 1 wei at 24dp normalizes to 0 at 18dp — must not throw division by zero
    const pd = computePriceDifference(
      pool({
        reserves0: 1n,
        reserves1: 1_000_000_000_000_000_000n,
        oraclePrice: SCALE,
        token0Decimals: 24,
        token1Decimals: 18,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("balanced pool returns 0 deviation", () => {
    // reserves match oracle exactly: 1:1, oracle = 1.0
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000n,
        reserves1: 1_000_000_000_000_000_000n,
        oraclePrice: SCALE,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("balanced pool with invertRateFeed=true returns 0 deviation", () => {
    // reserve1/reserve0 = 1.0, invertRateFeed oracle = 1/1.0 = 1.0
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000n,
        reserves1: 1_000_000_000_000_000_000n,
        oraclePrice: SCALE,
        invertRateFeed: true,
      }),
    );
    assert.equal(pd, 0n);
  });
});
