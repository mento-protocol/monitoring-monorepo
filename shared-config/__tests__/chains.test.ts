import { describe, it, expect } from "vitest";
import {
  chainSlug,
  chainLabel,
  hasChain,
  explorerBaseUrl,
  explorerAddressUrl,
  explorerTxUrl,
} from "../src/chains";

describe("chainSlug", () => {
  it.each([
    [42220, "celo"],
    [143, "monad"],
    [11142220, "celo-sepolia"],
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
    [11142220, "Celo Sepolia"],
  ])("maps chainId %i to %s", (chainId, expected) => {
    expect(chainLabel(chainId)).toBe(expected);
  });

  it("falls back to slug for unknown chains", () => {
    expect(chainLabel(99999)).toBe("99999");
  });
});

describe("hasChain", () => {
  it.each([42220, 143, 11142220])(
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
  ])("builds tx URL for chainId %i", (chainId, expected) => {
    expect(explorerTxUrl(chainId, "0xtx")).toBe(expected);
  });

  it("returns null for unknown chains", () => {
    expect(explorerTxUrl(99999, "0xtx")).toBeNull();
  });
});
