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
// contracts.json integration — deterministic namespace selection + exact addresses
// ---------------------------------------------------------------------------
import contractsJson from "@mento-protocol/contracts/contracts.json";

// Explicit namespace map (mirrors CONTRACT_NAMESPACE_BY_CHAIN in EventHandlers.ts).
// Tests use these to ensure address resolution is deterministic and namespace-specific.
const CONTRACT_NAMESPACE_BY_CHAIN: Record<number, string> = {
  42220: "mainnet",
  11142220: "testnet-v2-rc5",
};

type ContractsJson = Record<
  string,
  Record<string, Record<string, { address: string }>>
>;

function getAddressViaNamespace(
  chainId: number,
  contractName: string,
): string | undefined {
  const ns = CONTRACT_NAMESPACE_BY_CHAIN[chainId];
  if (!ns) return undefined;
  return (contractsJson as ContractsJson)[String(chainId)]?.[ns]?.[
    contractName
  ]?.address;
}

describe("@mento-protocol/contracts — deterministic namespace address resolution", () => {
  it("SortedOracles on Celo mainnet (42220/mainnet) resolves to exact known address", () => {
    const addr = getAddressViaNamespace(42220, "SortedOracles");
    // Exact address verified from Celo mainnet deployment
    assert.equal(
      addr?.toLowerCase(),
      "0xefb84935239dacdecf7c5ba76d8de40b077b7b33",
      "SortedOracles mainnet address mismatch — upstream package may have changed",
    );
  });

  it("USDm on Celo mainnet (42220/mainnet) resolves to exact known address", () => {
    const addr = getAddressViaNamespace(42220, "USDm");
    assert.equal(
      addr?.toLowerCase(),
      "0x765de816845861e75a25fca122bb6898b8b1282a",
      "USDm mainnet address mismatch",
    );
  });

  it("SortedOracles on Celo Sepolia (11142220/testnet-v2-rc5) resolves to exact known address", () => {
    const addr = getAddressViaNamespace(11142220, "SortedOracles");
    assert.equal(
      addr?.toLowerCase(),
      "0xfaa7ca2b056e60f6733ae75aa0709140a6eafd20",
      "SortedOracles Sepolia address mismatch",
    );
  });

  it("USDm on Celo Sepolia (11142220/testnet-v2-rc5) resolves to exact known address", () => {
    const addr = getAddressViaNamespace(11142220, "USDm");
    assert.equal(
      addr?.toLowerCase(),
      "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
      "USDm Sepolia address mismatch",
    );
  });

  it("does NOT fall through to wrong namespace for chainId 143 (monad, multiple namespaces)", () => {
    // Chain 143 has both 'monad-mainnet' and 'mainnet' namespaces.
    // We don't index chain 143, so getAddressViaNamespace should return undefined.
    const addr = getAddressViaNamespace(143, "USDm");
    assert.equal(addr, undefined, "Chain 143 is not in CONTRACT_NAMESPACE_BY_CHAIN — should be undefined");
  });
});
