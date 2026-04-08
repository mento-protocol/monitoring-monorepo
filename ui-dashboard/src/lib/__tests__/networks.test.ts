/**
 * Unit tests for makeNetwork() map-merge behavior in networks.ts.
 *
 * Focus: addressLabels and tokenSymbols overrides take precedence over
 * package-derived maps, tested via real same-key collisions.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  NETWORKS,
  makeNetwork,
  isConfiguredNetworkId,
  isNetworkId,
} from "../networks";
import { MAINNET_CHAIN_IDS } from "../types";

// Known Celo mainnet addresses from @mento-protocol/contracts (42220/mainnet).
// These are in the package-derived maps for any network using chainId 42220.
const USDM_ADDR = "0x765de816845861e75a25fca122bb6898b8b1282a";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("network constants stay in sync", () => {
  it("MAINNET_CHAIN_IDS matches production mainnet networks", () => {
    const prodMainnetChainIds = Object.values(NETWORKS)
      .filter((net) => !net.local && !net.testnet)
      .map((net) => net.chainId)
      .filter((chainId, idx, arr) => arr.indexOf(chainId) === idx)
      .sort((a, b) => a - b);

    expect([...MAINNET_CHAIN_IDS].sort((a, b) => a - b)).toEqual(
      prodMainnetChainIds,
    );
  });
});

describe("makeNetwork — addressLabels merge/override contract", () => {
  it("config override wins for same address key (real collision)", () => {
    // USDm address IS in the package-derived addressLabels for chainId 42220.
    // If we pass it as a config override, config must win (right-hand spread).
    const net = makeNetwork({
      id: "celo-mainnet",
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
      id: "celo-mainnet",
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
      id: "celo-mainnet",
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
      id: "celo-mainnet",
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
      id: "celo-mainnet",
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
  it("celo-sepolia has tokenSymbols and addressLabels from Sepolia namespace", () => {
    const sepolia = NETWORKS["celo-sepolia"];
    expect(Object.keys(sepolia.tokenSymbols).length).toBeGreaterThan(0);
    expect(Object.keys(sepolia.addressLabels).length).toBeGreaterThan(0);
  });

  it("celo-mainnet has all expected map properties and local=false", () => {
    const mainnet = NETWORKS["celo-mainnet"];
    expect(mainnet.tokenSymbols).toBeDefined();
    expect(mainnet.addressLabels).toBeDefined();
    expect(mainnet.local).toBe(false);
  });
});

describe("NETWORKS — local development defaults", () => {
  it("uses the local Hasura admin secret by default", () => {
    expect(NETWORKS.devnet.hasuraSecret).toBe("testing");
    expect(NETWORKS["celo-sepolia-local"].hasuraSecret).toBe("testing");
    expect(NETWORKS["celo-mainnet-local"].hasuraSecret).toBe("testing");
  });

  it("uses port 8080 for every local Hasura endpoint", () => {
    expect(NETWORKS.devnet.hasuraUrl).toBe("http://localhost:8080/v1/graphql");
    expect(NETWORKS["celo-sepolia-local"].hasuraUrl).toBe(
      "http://localhost:8080/v1/graphql",
    );
    expect(NETWORKS["celo-mainnet-local"].hasuraUrl).toBe(
      "http://localhost:8080/v1/graphql",
    );
  });
});

describe("NETWORKS — Monad networks", () => {
  const USDM_MONAD_MAINNET = "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115";
  const USDM_MONAD_TESTNET = "0x5ecc03111ad2a78f981a108759bc73bae2ab31bc";

  it("does not mark monad-mainnet configured when multichain URL is not set", async () => {
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL_MULTICHAIN", "");

    const networks = await import("../networks");
    expect(networks.NETWORKS["monad-mainnet"].hasuraUrl).toBe("");
    expect(networks.isConfiguredNetworkId("monad-mainnet")).toBe(false);
  });

  it("wires the multichain URL into both celo-mainnet and monad-mainnet, trimming whitespace", async () => {
    // Positive-path: non-empty multichain URL → both production networks visible.
    // Also verifies that leading/trailing whitespace is stripped (env var may
    // contain spaces in some CI setups).
    vi.stubEnv(
      "NEXT_PUBLIC_HASURA_URL_MULTICHAIN",
      "  https://indexer.hyperindex.xyz/2f3dd15/v1/graphql  ",
    );

    const networks = await import("../networks");
    expect(networks.NETWORKS["celo-mainnet"].hasuraUrl).toBe(
      "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql",
    );
    expect(networks.NETWORKS["monad-mainnet"].hasuraUrl).toBe(
      "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql",
    );
    expect(networks.isConfiguredNetworkId("celo-mainnet")).toBe(true);
    expect(networks.isConfiguredNetworkId("monad-mainnet")).toBe(true);
  });

  it("monad-mainnet has tokenSymbols populated from contracts package", () => {
    const monad = NETWORKS["monad-mainnet"];
    expect(Object.keys(monad.tokenSymbols).length).toBeGreaterThan(0);
    expect(monad.tokenSymbols[USDM_MONAD_MAINNET]).toBeDefined();
  });

  it("monad-mainnet has addressLabels populated from contracts package", () => {
    const monad = NETWORKS["monad-mainnet"];
    expect(Object.keys(monad.addressLabels).length).toBeGreaterThan(0);
  });

  it("monad-testnet has tokenSymbols populated — @mento-protocol/contracts v0.3.0", () => {
    const testnet = NETWORKS["monad-testnet"];
    expect(Object.keys(testnet.tokenSymbols).length).toBeGreaterThan(0);
    // USDm on Monad testnet (testnet-v2-rc5 namespace)
    expect(testnet.tokenSymbols[USDM_MONAD_TESTNET]).toBeDefined();
    expect(testnet.chainId).toBe(10143);
    expect(testnet.local).toBe(false);
  });

  it("monad network visibility is gated on hasuraUrl being set", () => {
    // isConfiguredNetworkId() is the single source of truth for routing.
    // Whether Monad is visible depends on env vars — both outcomes are valid here;
    // the routing guard correctness is tested in isConfiguredNetworkId suite below.
    const monadMainnet = NETWORKS["monad-mainnet"];
    const monadTestnet = NETWORKS["monad-testnet"];
    // The contract: if hasuraUrl is empty, isConfiguredNetworkId must return false.
    if (!monadMainnet.hasuraUrl) {
      expect(isConfiguredNetworkId("monad-mainnet")).toBe(false);
    }
    if (!monadTestnet.hasuraUrl) {
      expect(isConfiguredNetworkId("monad-testnet")).toBe(false);
    }
  });

  it("monad networks do not expose virtual pool UI", () => {
    expect(NETWORKS["monad-mainnet"].hasVirtualPools).toBe(false);
    expect(NETWORKS["monad-testnet"].hasVirtualPools).toBe(false);
  });
});

describe("NETWORKS — virtual pool support", () => {
  it("enables virtual pools for all Celo networks, disables for Monad", () => {
    expect(NETWORKS.devnet.hasVirtualPools).toBe(true);
    expect(NETWORKS["celo-sepolia-local"].hasVirtualPools).toBe(true);
    expect(NETWORKS["celo-sepolia"].hasVirtualPools).toBe(true);
    expect(NETWORKS["celo-mainnet-local"].hasVirtualPools).toBe(true);
    expect(NETWORKS["celo-mainnet"].hasVirtualPools).toBe(true);
  });
});

describe("isConfiguredNetworkId — URL routing guard", () => {
  it("returns a boolean for any known network id", () => {
    // Correctness: the function must not throw for any defined network.
    expect(typeof isConfiguredNetworkId("celo-mainnet")).toBe("boolean");
    expect(typeof isConfiguredNetworkId("monad-mainnet")).toBe("boolean");
    expect(typeof isConfiguredNetworkId("monad-testnet")).toBe("boolean");
  });

  it("returns false for unknown network id regardless of env", () => {
    expect(isConfiguredNetworkId("not-a-real-network")).toBe(false);
  });

  it("rejects legacy -hosted network IDs", () => {
    expect(isNetworkId("celo-mainnet-hosted")).toBe(false);
    expect(isNetworkId("celo-sepolia-hosted")).toBe(false);
    expect(isNetworkId("monad-mainnet-hosted")).toBe(false);
    expect(isNetworkId("monad-testnet-hosted")).toBe(false);
  });

  it("never returns true for a network with empty hasuraUrl", () => {
    // Core invariant: no empty-URL network can be navigated to.
    // This holds regardless of which env vars are set.
    const unconfigured = Object.entries(NETWORKS).filter(
      ([, n]) => !n.hasuraUrl,
    );
    for (const [id] of unconfigured) {
      expect(isConfiguredNetworkId(id)).toBe(false);
    }
  });

  it("never returns false for a non-local network with a populated hasuraUrl", () => {
    // Inverse: if URL is set and network is not local, it must be routable.
    const configured = Object.entries(NETWORKS).filter(
      ([, n]) => !!n.hasuraUrl && !n.local,
    );
    for (const [id] of configured) {
      expect(isConfiguredNetworkId(id)).toBe(true);
    }
  });
});
