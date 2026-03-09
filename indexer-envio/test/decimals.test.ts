/// <reference types="mocha" />
import { strict as assert } from "assert";
import { normalizeTo18, scalingFactorToDecimals } from "../src/EventHandlers";

describe("normalizeTo18", () => {
  it("is a no-op for 18-decimal tokens", () => {
    assert.equal(
      normalizeTo18(1_000_000_000_000_000_000n, 18),
      1_000_000_000_000_000_000n,
    );
  });

  it("scales up 6-decimal tokens (USDT/USDC) to 18dp", () => {
    // 1 USDT = 1_000_000 (6dp) → 1_000_000_000_000_000_000 (18dp)
    assert.equal(normalizeTo18(1_000_000n, 6), 1_000_000_000_000_000_000n);
  });

  it("scales down >18-decimal tokens", () => {
    // 1 token at 24dp → 18dp: divide by 10^6
    assert.equal(
      normalizeTo18(1_000_000_000_000_000_000_000_000n, 24),
      1_000_000_000_000_000_000n,
    );
  });

  it("handles zero amount", () => {
    assert.equal(normalizeTo18(0n, 6), 0n);
  });
});

describe("scalingFactorToDecimals", () => {
  it("converts 1e18 → 18", () => {
    assert.equal(scalingFactorToDecimals(1_000_000_000_000_000_000n), 18);
  });

  it("converts 1e6 → 6 (USDT/USDC)", () => {
    assert.equal(scalingFactorToDecimals(1_000_000n), 6);
  });

  it("converts 1 → 0 (zero-decimal token)", () => {
    assert.equal(scalingFactorToDecimals(1n), 0);
  });

  it("returns null for non-power-of-10 values", () => {
    assert.equal(scalingFactorToDecimals(1_500_000n), null);
  });

  it("returns null for zero or negative", () => {
    assert.equal(scalingFactorToDecimals(0n), null);
  });
});
