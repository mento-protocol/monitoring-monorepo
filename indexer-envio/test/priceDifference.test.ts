/// <reference types="mocha" />
import { strict as assert } from "assert";
import { computePriceDifference } from "../src/EventHandlers";
import { getContractAddress } from "../src/contractAddresses";

// Resolve real USDm addresses so tests exercise the actual USDM_ADDRESSES set.
const USDM_CELO = getContractAddress(42220, "USDm")!;
const NON_USDM = "0x0000000000000000000000000000000000000001";

const SCALE = 10n ** 24n;

// Helper: build a pool input for computePriceDifference.
function pool(opts: {
  reserves0: bigint;
  reserves1: bigint;
  oraclePrice: bigint;
  token0: string;
  token1: string;
  token0Decimals?: number;
  token1Decimals?: number;
}) {
  return {
    token0Decimals: 18,
    token1Decimals: 18,
    ...opts,
  };
}

describe("computePriceDifference", () => {
  // -----------------------------------------------------------------------
  // Contract-verified scenario: pool 0xb0a... on Monad
  // getRebalancingState returns priceDifference = 3333 bps
  // reservePrice = 40017e18 / 60026e18 ≈ 0.6668, oracle ≈ 1.0
  // -----------------------------------------------------------------------

  const ORACLE_PRICE = 999_992_860_000_000_000_000_000n; // ≈ 1.0 at 24dp
  const R0_USDM = 40_017_373_654_286_326_120_236n; // ~40k USDm (18dp)
  const R1_NON = 60_025_803_785_000_000_000_000n; // ~60k nonUSD (18dp)

  it("USDm is token0 — matches contract priceDifference (3333 bps)", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R0_USDM,
        reserves1: R1_NON,
        oraclePrice: ORACLE_PRICE,
        token0: USDM_CELO,
        token1: NON_USDM,
      }),
    );
    assert.equal(pd, 3333n);
  });

  it("USDm is token1 — same result as token0 (3333 bps)", () => {
    // Swap token order: reserves are flipped, USDm is now token1
    const pd = computePriceDifference(
      pool({
        reserves0: R1_NON,
        reserves1: R0_USDM,
        oraclePrice: ORACLE_PRICE,
        token0: NON_USDM,
        token1: USDM_CELO,
      }),
    );
    assert.equal(pd, 3333n);
  });

  // -----------------------------------------------------------------------
  // Mixed decimals: token0 = USDC (6dp), token1 = USDm (18dp)
  // -----------------------------------------------------------------------

  it("mixed decimals: 6dp token0, 18dp USDm token1", () => {
    // 60k USDC at 6dp = 60_025_803_785, 40k USDm at 18dp
    const pd = computePriceDifference(
      pool({
        reserves0: 60_025_803_785n,
        reserves1: R0_USDM,
        oraclePrice: ORACLE_PRICE,
        token0: NON_USDM,
        token1: USDM_CELO,
        token0Decimals: 6,
        token1Decimals: 18,
      }),
    );
    assert.equal(pd, 3333n);
  });

  it("mixed decimals: 18dp USDm token0, 6dp token1", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R0_USDM,
        reserves1: 60_025_803_785n,
        oraclePrice: ORACLE_PRICE,
        token0: USDM_CELO,
        token1: NON_USDM,
        token0Decimals: 18,
        token1Decimals: 6,
      }),
    );
    assert.equal(pd, 3333n);
  });

  // -----------------------------------------------------------------------
  // GBP/USD style: oracle ≈ 1.34, deviation ≈ 33.6%
  // -----------------------------------------------------------------------

  it("non-unity oracle (GBP/USD ≈ 1.34)", () => {
    const gbpOracle = 1_340_000_000_000_000_000_000_000n; // 1.34 at 24dp
    // Balanced would be 1.34 USDm per GBPm. Current: 0.89 USDm per GBPm.
    const usdmReserves = 890_000_000_000_000_000_000n; // 0.89 USDm (18dp)
    const gbpmReserves = 1_000_000_000_000_000_000_000n; // 1.0 GBPm (18dp)

    const pd0 = computePriceDifference(
      pool({
        reserves0: usdmReserves,
        reserves1: gbpmReserves,
        oraclePrice: gbpOracle,
        token0: USDM_CELO,
        token1: NON_USDM,
      }),
    );

    const pd1 = computePriceDifference(
      pool({
        reserves0: gbpmReserves,
        reserves1: usdmReserves,
        oraclePrice: gbpOracle,
        token0: NON_USDM,
        token1: USDM_CELO,
      }),
    );

    // Both directions must give the same result
    assert.equal(pd0, pd1, "token order should not affect priceDifference");
    // Deviation: |0.89 - 1.34| / 1.34 ≈ 33.58% ≈ 3358 bps
    assert.ok(pd0 >= 3350n && pd0 <= 3360n, `expected ~3358 bps, got ${pd0}`);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("returns 0 when oracle price is 0", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R0_USDM,
        reserves1: R1_NON,
        oraclePrice: 0n,
        token0: USDM_CELO,
        token1: NON_USDM,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("returns 0 when reserves are 0", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: 0n,
        reserves1: R1_NON,
        oraclePrice: ORACLE_PRICE,
        token0: USDM_CELO,
        token1: NON_USDM,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("returns 0 when neither token is USDm", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R0_USDM,
        reserves1: R1_NON,
        oraclePrice: ORACLE_PRICE,
        token0: NON_USDM,
        token1: "0x0000000000000000000000000000000000000002",
      }),
    );
    assert.equal(pd, 0n);
  });

  it("extreme imbalance: very small nonUSD reserve (USDm is token1)", () => {
    // 1 wei of nonUSD vs 1e18 USDm — extreme imbalance, should not throw
    const pd = computePriceDifference(
      pool({
        reserves0: 1n, // tiny nonUSD
        reserves1: 1_000_000_000_000_000_000n, // 1 USDm
        oraclePrice: SCALE, // oracle = 1.0
        token0: NON_USDM,
        token1: USDM_CELO,
      }),
    );
    // reserveRatio = 1e18 * SCALE / 1 = 1e42, oracle = 1e24
    // deviation = (1e42 - 1e24) * 10000 / 1e24 ≈ 9.999…e21 bps (>> 10000 bps)
    assert.ok(
      pd > 10000n,
      `extreme imbalance should far exceed 100%, got ${pd}`,
    );
  });

  it("balanced pool returns 0 deviation", () => {
    // reserves match oracle exactly: 1 USDm per 1 nonUSD, oracle = 1.0
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000n,
        reserves1: 1_000_000_000_000_000_000n,
        oraclePrice: SCALE, // exactly 1.0
        token0: USDM_CELO,
        token1: NON_USDM,
      }),
    );
    assert.equal(pd, 0n);
  });
});
