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
// contracts.json integration — assert required chain IDs and addresses exist
// ---------------------------------------------------------------------------
import contractsJson from "@mento-protocol/contracts/contracts.json";

describe("@mento-protocol/contracts address assertions", () => {
  const CELO_MAINNET_CHAIN_ID = "42220";
  const CELO_SEPOLIA_CHAIN_ID = "11142220";

  function getAddress(chainId: string, contractName: string): string | undefined {
    const chain = (contractsJson as Record<string, Record<string, Record<string, { address: string }>>>)[chainId];
    if (!chain) return undefined;
    for (const contracts of Object.values(chain)) {
      if (contracts[contractName]?.address) return contracts[contractName].address;
    }
    return undefined;
  }

  it("SortedOracles address exists on Celo mainnet (42220)", () => {
    const addr = getAddress(CELO_MAINNET_CHAIN_ID, "SortedOracles");
    assert.ok(addr, "SortedOracles address missing for chainId 42220");
    assert.match(addr, /^0x[0-9a-fA-F]{40}$/, "Not a valid address");
  });

  it("SortedOracles address exists on Celo Sepolia (11142220)", () => {
    const addr = getAddress(CELO_SEPOLIA_CHAIN_ID, "SortedOracles");
    assert.ok(addr, "SortedOracles address missing for chainId 11142220");
    assert.match(addr, /^0x[0-9a-fA-F]{40}$/, "Not a valid address");
  });

  it("USDm address exists on Celo mainnet (42220)", () => {
    const addr = getAddress(CELO_MAINNET_CHAIN_ID, "USDm");
    assert.ok(addr, "USDm address missing for chainId 42220");
    assert.match(addr, /^0x[0-9a-fA-F]{40}$/, "Not a valid address");
  });
});
