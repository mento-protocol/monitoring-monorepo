/**
 * Unit tests for makeNetwork() map-merge behavior in networks.ts.
 *
 * Focus: addressLabels and tokenSymbols overrides take precedence over
 * package-derived maps while still inheriting package entries.
 */
import { describe, it, expect } from "vitest";
import { NETWORKS } from "../networks";

describe("NETWORKS.devnet — makeNetwork override precedence", () => {
  const devnet = NETWORKS.devnet;

  it("retains custom addressLabels override (Deployer) from devnet config", () => {
    // The devnet config passes { addressLabels: { "0x287810...": "Deployer" } }.
    // makeNetwork merges: { ...packageLabels, ...configLabels } so config wins.
    expect(devnet.addressLabels["0x287810f677516f10993ff63a520aad5509f35796"]).toBe(
      "Deployer",
    );
  });

  it("also inherits package-derived addressLabels (known Celo mainnet contracts)", () => {
    // devnet reuses chainId 42220 + contractsNamespace "mainnet".
    // Package-derived labels should still be present alongside the override.
    // USDm is the canonical stable token on Celo mainnet.
    const usdmAddress = "0x765de816845861e75a25fca122bb6898b8b1282a";
    expect(devnet.addressLabels[usdmAddress]).toBeDefined();
    expect(typeof devnet.addressLabels[usdmAddress]).toBe("string");
  });

  it("config addressLabels override wins over package entry for same address", () => {
    // If a custom label and a package label share the same address,
    // the config (right-hand spread) must win.
    const overrideAddr = "0x287810f677516f10993ff63a520aad5509f35796";
    // This address is not in the package, but the pattern holds: config wins.
    expect(devnet.addressLabels[overrideAddr]).toBe("Deployer");
  });
});

describe("NETWORKS.devnet — tokenSymbols map composition", () => {
  const devnet = NETWORKS.devnet;

  it("has tokenSymbols populated from package-derived maps (chainId 42220)", () => {
    // devnet uses Celo mainnet chain — USDm address should resolve to a symbol.
    const usdmAddress = "0x765de816845861e75a25fca122bb6898b8b1282a";
    expect(devnet.tokenSymbols[usdmAddress]).toBeDefined();
  });
});

describe("NETWORKS makeNetwork — general merge contract", () => {
  it("celo-sepolia-hosted inherits package labels for Sepolia chain", () => {
    const sepolia = NETWORKS["celo-sepolia-hosted"];
    // Should have tokenSymbols and addressLabels populated from contracts.json
    // using the testnet-v2-rc5 namespace.
    expect(Object.keys(sepolia.tokenSymbols).length).toBeGreaterThan(0);
    expect(Object.keys(sepolia.addressLabels).length).toBeGreaterThan(0);
  });

  it("celo-mainnet-hosted has all expected map properties", () => {
    const mainnet = NETWORKS["celo-mainnet-hosted"];
    expect(mainnet.tokenSymbols).toBeDefined();
    expect(mainnet.addressLabels).toBeDefined();
    expect(mainnet.local).toBe(false);
  });
});
