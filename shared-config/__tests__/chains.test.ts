import { describe, it, expect } from "vitest";
import chainMetadataJson from "../chain-metadata.json" with { type: "json" };
import deploymentNamespacesJson from "../deployment-namespaces.json" with { type: "json" };
import {
  chainSlug,
  chainLabel,
  hasChain,
  explorerBaseUrl,
  explorerAddressUrl,
  explorerTxUrl,
} from "../src/chains";

describe("chain metadata registry", () => {
  it("covers every chain in the deployment namespace registry", () => {
    expect(Object.keys(chainMetadataJson).sort()).toEqual(
      Object.keys(deploymentNamespacesJson).sort(),
    );
  });
});

describe("chainSlug", () => {
  it.each([
    [42220, "celo"],
    [143, "monad"],
    [137, "polygon"],
    [11142220, "celo-sepolia"],
    [10143, "monad-testnet"],
    [80002, "polygon-amoy"],
  ])("maps chainId %i to %s", (chainId, expected) => {
    expect(chainSlug(chainId)).toBe(expected);
  });

  it("falls back to stringified chainId for unknown chains", () => {
    expect(chainSlug(99999)).toBe("99999");
  });
});

describe("chainLabel", () => {
  it.each([
    [42220, "Celo"],
    [143, "Monad"],
    [137, "Polygon"],
    [11142220, "Celo Sepolia"],
    [10143, "Monad Testnet"],
    [80002, "Polygon Amoy"],
  ])("maps chainId %i to %s", (chainId, expected) => {
    expect(chainLabel(chainId)).toBe(expected);
  });

  it("falls back to slug for unknown chains", () => {
    expect(chainLabel(99999)).toBe("99999");
  });
});

describe("hasChain", () => {
  it.each([42220, 143, 137, 11142220, 10143, 80002])(
    "returns true for registered chainId %i",
    (chainId) => {
      expect(hasChain(chainId)).toBe(true);
    },
  );

  it("returns false for unknown chains", () => {
    expect(hasChain(99999)).toBe(false);
  });
});

describe("explorerBaseUrl", () => {
  it("returns base URL for known chains", () => {
    expect(explorerBaseUrl(42220)).toBe("https://celoscan.io");
    expect(explorerBaseUrl(143)).toBe("https://monadscan.com");
    expect(explorerBaseUrl(137)).toBe("https://polygonscan.com");
  });

  it("returns null for unknown chains", () => {
    expect(explorerBaseUrl(99999)).toBeNull();
  });
});

describe("explorerAddressUrl", () => {
  it("builds address URL for known chains", () => {
    expect(explorerAddressUrl(42220, "0xabc")).toBe(
      "https://celoscan.io/address/0xabc",
    );
    expect(explorerAddressUrl(143, "0xdef")).toBe(
      "https://monadscan.com/address/0xdef",
    );
    expect(explorerAddressUrl(80002, "0xdef")).toBe(
      "https://amoy.polygonscan.com/address/0xdef",
    );
  });

  it("returns null for unknown chains", () => {
    expect(explorerAddressUrl(99999, "0xabc")).toBeNull();
  });
});

describe("explorerTxUrl", () => {
  it.each([
    [42220, "https://celoscan.io/tx/0xtx"],
    [143, "https://monadscan.com/tx/0xtx"],
    [11142220, "https://celo-sepolia.blockscout.com/tx/0xtx"],
    [10143, "https://testnet.monadscan.com/tx/0xtx"],
    [137, "https://polygonscan.com/tx/0xtx"],
    [80002, "https://amoy.polygonscan.com/tx/0xtx"],
  ])("builds tx URL for chainId %i", (chainId, expected) => {
    expect(explorerTxUrl(chainId, "0xtx")).toBe(expected);
  });

  it("returns null for unknown chains", () => {
    expect(explorerTxUrl(99999, "0xtx")).toBeNull();
  });
});
