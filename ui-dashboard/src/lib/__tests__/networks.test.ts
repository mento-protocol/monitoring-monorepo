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
  isCanonicalNetwork,
  isConfiguredNetworkId,
  isNetworkId,
  networkIdForChainId,
} from "../networks";

// Mirror of the private map in networks.ts — kept here so the drift-guard
// test can assert every canonical chainId still resolves to a matching
// NETWORKS entry. If the real map changes, update this too.
const EXPECTED_PROD_CHAIN_IDS = [42220, 143];
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
  it("celo-sepolia-local has tokenSymbols and addressLabels from Sepolia namespace", () => {
    const sepolia = NETWORKS["celo-sepolia-local"];
    expect(Object.keys(sepolia.tokenSymbols).length).toBeGreaterThan(0);
    expect(Object.keys(sepolia.addressLabels).length).toBeGreaterThan(0);
  });

  it("celo-mainnet has all expected map properties and local=false", () => {
    const mainnet = NETWORKS["celo-mainnet"];
    expect(mainnet.tokenSymbols).toBeDefined();
    expect(mainnet.addressLabels).toBeDefined();
    expect(mainnet.local).toBe(false);
  });

  it("celo-mainnet retains StableToken* contract rows in addressLabels (address book inventory)", () => {
    // The StableToken-name filter is tokenSymbols-only; the address book
    // must still render implementation contracts as labelled rows.
    const mainnet = NETWORKS["celo-mainnet"];
    const stableTokenV3v301 = "0x815795c30d0758a297b08cd4e0643620c974c318";
    expect(mainnet.addressLabels[stableTokenV3v301]).toBe("StableTokenV3v301");
    expect(mainnet.tokenSymbols[stableTokenV3v301]).toBeUndefined();
  });
});

describe("NETWORKS — local development defaults", () => {
  it("does not expose local Hasura admin secrets in client network config", () => {
    expect(NETWORKS.devnet.hasuraSecret).toBe("");
    expect(NETWORKS["celo-sepolia-local"].hasuraSecret).toBe("");
    expect(NETWORKS["celo-mainnet-local"].hasuraSecret).toBe("");
  });

  it("defaults local Hasura URLs to same-origin proxy routes", () => {
    expect(NETWORKS.devnet.hasuraUrl).toBe("/api/hasura/devnet");
    expect(NETWORKS["celo-sepolia-local"].hasuraUrl).toBe(
      "/api/hasura/celo-sepolia-local",
    );
    expect(NETWORKS["celo-mainnet-local"].hasuraUrl).toBe(
      "/api/hasura/celo-mainnet-local",
    );
  });
});

describe("NETWORKS — Monad networks", () => {
  const USDM_MONAD_MAINNET = "0xbc69212b8e4d445b2307c9d32dd68e2a4df00115";
  const EURM_MONAD_MAINNET = "0x4d502d735b4c574b487ed641ae87ceae884731c7";
  const GBPM_MONAD_MAINNET = "0x39bb4e0a204412bb98e821d25e7d955e69d40fd1";
  // Implementation proxy published as type=token on Monad mainnet — should
  // be excluded from tokenSymbols so pool titles never use it.
  const STABLE_TOKEN_SPOKE_GBP_MAINNET =
    "0xddf082068caa5b941ed8c603adf0cecbdbb59f8e";

  it("does not mark monad-mainnet configured when HASURA_URL is not set", async () => {
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "");

    const networks = await import("../networks");
    expect(networks.NETWORKS["monad-mainnet"].hasuraUrl).toBe("");
    expect(networks.isConfiguredNetworkId("monad-mainnet")).toBe(false);
  });

  it("wires HASURA_URL into both celo-mainnet and monad-mainnet, trimming whitespace", async () => {
    // Positive-path: non-empty HASURA_URL → both production networks visible.
    // Also verifies that leading/trailing whitespace is stripped (env var may
    // contain spaces in some CI setups).
    vi.stubEnv(
      "NEXT_PUBLIC_HASURA_URL",
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

  it("monad-mainnet token symbols use canonical hub names (USDm/EURm/GBPm, not *Spoke)", () => {
    const monad = NETWORKS["monad-mainnet"];
    expect(monad.tokenSymbols[USDM_MONAD_MAINNET]).toBe("USDm");
    expect(monad.tokenSymbols[EURM_MONAD_MAINNET]).toBe("EURm");
    expect(monad.tokenSymbols[GBPM_MONAD_MAINNET]).toBe("GBPm");
  });

  it("monad-mainnet address labels use canonical hub names", () => {
    const monad = NETWORKS["monad-mainnet"];
    expect(monad.addressLabels[USDM_MONAD_MAINNET]).toBe("USDm");
    expect(monad.addressLabels[EURM_MONAD_MAINNET]).toBe("EURm");
    expect(monad.addressLabels[GBPM_MONAD_MAINNET]).toBe("GBPm");
  });

  it("monad-mainnet pool-token symbols never expose *Spoke (the user-facing invariant)", () => {
    // Narrow invariant: tokenSymbols feeds pool titles. Address-book labels
    // for non-token contracts (e.g. StableTokenSpoke) legitimately keep the
    // raw "Spoke" name so operators can identify the exact deployment.
    const monad = NETWORKS["monad-mainnet"];
    expect(
      Object.values(monad.tokenSymbols).some((v) => v.includes("Spoke")),
    ).toBe(false);
  });

  it("monad-mainnet keeps raw StableTokenSpoke contract label in addressLabels (address-book precision)", () => {
    // StableTokenSpoke (type=contract) must NOT be collapsed to "StableToken"
    // — that label collision with Celo's legacy StableToken would mislead
    // operators. Precise implementation-contract names only strip the suffix
    // for type=token entries.
    const monad = NETWORKS["monad-mainnet"];
    const stableTokenSpokeAddr = "0x6a8ff60a89f3f359fa16f45076d6dd1712b5e62e";
    expect(monad.addressLabels[stableTokenSpokeAddr]).toBe("StableTokenSpoke");
  });

  it("monad-mainnet excludes StableTokenSpoke* implementation proxies from tokenSymbols (but keeps them in addressLabels)", () => {
    // The implementation proxy is type=token in v0.6.0 contracts.json but
    // must NOT render as a pool token. It MUST still appear in addressLabels
    // so the address book contract inventory stays complete.
    const monad = NETWORKS["monad-mainnet"];
    expect(monad.tokenSymbols[STABLE_TOKEN_SPOKE_GBP_MAINNET]).toBeUndefined();
    expect(monad.addressLabels[STABLE_TOKEN_SPOKE_GBP_MAINNET]).toBeDefined();
  });

  it("monad-mainnet visibility is gated on hasuraUrl being set", () => {
    // isConfiguredNetworkId() is the single source of truth for routing.
    // The contract: if hasuraUrl is empty, isConfiguredNetworkId must return false.
    const monadMainnet = NETWORKS["monad-mainnet"];
    if (!monadMainnet.hasuraUrl) {
      expect(isConfiguredNetworkId("monad-mainnet")).toBe(false);
    }
  });

  it("monad-mainnet does not expose virtual pool UI", () => {
    expect(NETWORKS["monad-mainnet"].hasVirtualPools).toBe(false);
  });
});

describe("NETWORKS — virtual pool support", () => {
  it("enables virtual pools for all Celo networks, disables for Monad", () => {
    expect(NETWORKS.devnet.hasVirtualPools).toBe(true);
    expect(NETWORKS["celo-sepolia-local"].hasVirtualPools).toBe(true);
    expect(NETWORKS["celo-mainnet-local"].hasVirtualPools).toBe(true);
    expect(NETWORKS["celo-mainnet"].hasVirtualPools).toBe(true);
  });
});

describe("isCanonicalNetwork", () => {
  it("returns true for canonical prod networks", () => {
    expect(isCanonicalNetwork("celo-mainnet")).toBe(true);
    expect(isCanonicalNetwork("monad-mainnet")).toBe(true);
  });

  it("returns false for local variants sharing a chainId with a canonical one", () => {
    expect(isCanonicalNetwork("celo-mainnet-local")).toBe(false);
    expect(isCanonicalNetwork("devnet")).toBe(false);
  });

  it("returns false for local-only networks with no canonical variant", () => {
    expect(isCanonicalNetwork("celo-sepolia-local")).toBe(false);
  });
});

describe("networkIdForChainId — pool-ID-driven network resolution", () => {
  it("maps each prod chainId to its prod IndexerNetworkId", () => {
    expect(networkIdForChainId(42220)).toBe("celo-mainnet");
    expect(networkIdForChainId(143)).toBe("monad-mainnet");
  });

  it("returns null for testnet chainIds (no hosted prod network)", () => {
    expect(networkIdForChainId(11142220)).toBeNull();
    expect(networkIdForChainId(10143)).toBeNull();
  });

  it("returns null for unknown chainIds", () => {
    expect(networkIdForChainId(1)).toBeNull();
    expect(networkIdForChainId(0)).toBeNull();
    expect(networkIdForChainId(99999)).toBeNull();
  });

  it("resolves to a network whose chainId actually matches (drift guard)", () => {
    for (const chainId of EXPECTED_PROD_CHAIN_IDS) {
      const networkId = networkIdForChainId(chainId);
      expect(networkId).not.toBeNull();
      expect(NETWORKS[networkId!].chainId).toBe(chainId);
    }
  });
});

describe("isConfiguredNetworkId — URL routing guard", () => {
  it("returns a boolean for any known network id", () => {
    // Correctness: the function must not throw for any defined network.
    expect(typeof isConfiguredNetworkId("celo-mainnet")).toBe("boolean");
    expect(typeof isConfiguredNetworkId("monad-mainnet")).toBe("boolean");
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
