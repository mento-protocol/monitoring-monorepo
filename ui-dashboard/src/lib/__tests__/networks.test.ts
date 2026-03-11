/**
 * Unit tests for makeNetwork() map-merge behavior in networks.ts.
 *
 * Focus: addressLabels and tokenSymbols overrides take precedence over
 * package-derived maps, tested via real same-key collisions.
 */
import { describe, it, expect } from "vitest";
import { NETWORKS, makeNetwork } from "../networks";

// Known Celo mainnet addresses from @mento-protocol/contracts (42220/mainnet).
// These are in the package-derived maps for any network using chainId 42220.
const USDM_ADDR = "0x765de816845861e75a25fca122bb6898b8b1282a";

describe("makeNetwork — addressLabels merge/override contract", () => {
  it("config override wins for same address key (real collision)", () => {
    // USDm address IS in the package-derived addressLabels for chainId 42220.
    // If we pass it as a config override, config must win (right-hand spread).
    const net = makeNetwork({
      id: "celo-mainnet-hosted",
      label: "Test",
      chainId: 42220,
      contractsNamespace: "mainnet",
      hasuraUrl: "http://localhost",
      hasuraSecret: "secret",
      explorerBaseUrl: "http://localhost",
      addressLabels: {
        [USDM_ADDR]: "MyCustomLabel", // collision with package-derived "USDm"
      },
    });
    // Config value must win over package-derived value for the same key.
    expect(net.addressLabels[USDM_ADDR]).toBe("MyCustomLabel");
  });

  it("package-derived addressLabels are inherited when no override for that key", () => {
    const net = makeNetwork({
      id: "celo-mainnet-hosted",
      label: "Test",
      chainId: 42220,
      contractsNamespace: "mainnet",
      hasuraUrl: "http://localhost",
      hasuraSecret: "secret",
      explorerBaseUrl: "http://localhost",
      // no override for USDm address
    });
    expect(net.addressLabels[USDM_ADDR]).toBeDefined();
    expect(typeof net.addressLabels[USDM_ADDR]).toBe("string");
  });

  it("config-only entry is present alongside package-derived entries", () => {
    const customAddr = "0x1234000000000000000000000000000000005678";
    const net = makeNetwork({
      id: "celo-mainnet-hosted",
      label: "Test",
      chainId: 42220,
      contractsNamespace: "mainnet",
      hasuraUrl: "http://localhost",
      hasuraSecret: "secret",
      explorerBaseUrl: "http://localhost",
      addressLabels: { [customAddr]: "Custom" },
    });
    expect(net.addressLabels[customAddr]).toBe("Custom"); // config entry present
    expect(net.addressLabels[USDM_ADDR]).toBeDefined(); // package entry also present
  });
});

describe("makeNetwork — tokenSymbols merge/override contract", () => {
  it("config override wins for same address key (real collision)", () => {
    // USDm address is in package-derived tokenSymbols for chainId 42220.
    const net = makeNetwork({
      id: "celo-mainnet-hosted",
      label: "Test",
      chainId: 42220,
      contractsNamespace: "mainnet",
      hasuraUrl: "http://localhost",
      hasuraSecret: "secret",
      explorerBaseUrl: "http://localhost",
      tokenSymbols: {
        [USDM_ADDR]: "CUSTOM_SYM", // collision with package-derived "USDm"
      },
    });
    expect(net.tokenSymbols[USDM_ADDR]).toBe("CUSTOM_SYM");
  });

  it("package-derived tokenSymbols are inherited when no override", () => {
    const net = makeNetwork({
      id: "celo-mainnet-hosted",
      label: "Test",
      chainId: 42220,
      contractsNamespace: "mainnet",
      hasuraUrl: "http://localhost",
      hasuraSecret: "secret",
      explorerBaseUrl: "http://localhost",
    });
    expect(net.tokenSymbols[USDM_ADDR]).toBeDefined();
    expect(net.tokenSymbols[USDM_ADDR]).toBe("USDm");
  });
});

describe("NETWORKS.devnet — real-world override retention", () => {
  const devnet = NETWORKS.devnet;

  it("retains custom Deployer addressLabel from devnet config", () => {
    expect(
      devnet.addressLabels["0x287810f677516f10993ff63a520aad5509f35796"],
    ).toBe("Deployer");
  });

  it("also inherits package-derived addressLabels alongside the override", () => {
    expect(devnet.addressLabels[USDM_ADDR]).toBeDefined();
  });

  it("has tokenSymbols populated from package maps", () => {
    expect(Object.keys(devnet.tokenSymbols).length).toBeGreaterThan(0);
    expect(devnet.tokenSymbols[USDM_ADDR]).toBe("USDm");
  });
});

describe("NETWORKS — general map composition", () => {
  it("celo-sepolia-hosted has tokenSymbols and addressLabels from Sepolia namespace", () => {
    const sepolia = NETWORKS["celo-sepolia-hosted"];
    expect(Object.keys(sepolia.tokenSymbols).length).toBeGreaterThan(0);
    expect(Object.keys(sepolia.addressLabels).length).toBeGreaterThan(0);
  });

  it("celo-mainnet-hosted has all expected map properties and local=false", () => {
    const mainnet = NETWORKS["celo-mainnet-hosted"];
    expect(mainnet.tokenSymbols).toBeDefined();
    expect(mainnet.addressLabels).toBeDefined();
    expect(mainnet.local).toBe(false);
  });
});
