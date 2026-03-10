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

// ---------------------------------------------------------------------------
// contractAddresses.ts integration — exercises real production lookup code
// ---------------------------------------------------------------------------
// Import from the shared module (same code used at runtime in EventHandlers.ts)
// so tests validate the actual implementation path rather than re-implementing it.
import {
  getContractAddress,
  requireContractAddress,
  CONTRACT_NAMESPACE_BY_CHAIN,
} from "../src/contractAddresses";

describe("contractAddresses — deterministic namespace address resolution", () => {
  it("SortedOracles on Celo mainnet (42220) resolves to exact known address", () => {
    const addr = getContractAddress(42220, "SortedOracles");
    assert.equal(
      addr?.toLowerCase(),
      "0xefb84935239dacdecf7c5ba76d8de40b077b7b33",
      "SortedOracles mainnet address mismatch — upstream package may have changed",
    );
  });

  it("USDm on Celo mainnet (42220) resolves to exact known address", () => {
    const addr = getContractAddress(42220, "USDm");
    assert.equal(
      addr?.toLowerCase(),
      "0x765de816845861e75a25fca122bb6898b8b1282a",
      "USDm mainnet address mismatch",
    );
  });

  it("SortedOracles on Celo Sepolia (11142220) resolves to exact known address", () => {
    const addr = getContractAddress(11142220, "SortedOracles");
    assert.equal(
      addr?.toLowerCase(),
      "0xfaa7ca2b056e60f6733ae75aa0709140a6eafd20",
      "SortedOracles Sepolia address mismatch",
    );
  });

  it("USDm on Celo Sepolia (11142220) resolves to exact known address", () => {
    const addr = getContractAddress(11142220, "USDm");
    assert.equal(
      addr?.toLowerCase(),
      "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
      "USDm Sepolia address mismatch",
    );
  });

  it("returns undefined for un-indexed chainId (143 — monad, multiple namespaces)", () => {
    // Chain 143 is not in CONTRACT_NAMESPACE_BY_CHAIN — should not fall through
    // to any namespace, including the 'mainnet' namespace that also exists on 143.
    const addr = getContractAddress(143, "USDm");
    assert.equal(
      addr,
      undefined,
      "Chain 143 is not indexed — should return undefined",
    );
  });

  it("requireContractAddress throws for un-indexed chainId", () => {
    assert.throws(
      () => requireContractAddress(999, "SortedOracles"),
      /Missing address for SortedOracles on chain 999/,
    );
  });

  it("requireContractAddress throws for unknown contract name", () => {
    assert.throws(
      () => requireContractAddress(42220, "NonExistentContract"),
      /Missing address for NonExistentContract on chain 42220/,
    );
  });

  it("CONTRACT_NAMESPACE_BY_CHAIN covers all expected indexed chains", () => {
    assert.ok(42220 in CONTRACT_NAMESPACE_BY_CHAIN, "Missing Celo mainnet");
    assert.ok(11142220 in CONTRACT_NAMESPACE_BY_CHAIN, "Missing Celo Sepolia");
    assert.equal(
      CONTRACT_NAMESPACE_BY_CHAIN[42220],
      "mainnet",
      "Wrong namespace for Celo mainnet",
    );
    assert.equal(
      CONTRACT_NAMESPACE_BY_CHAIN[11142220],
      "testnet-v2-rc5",
      "Wrong namespace for Celo Sepolia",
    );
  });
});
