import { describe, it, expect } from "vitest";
import {
  POOL_PAIR_LABELS,
  blockExplorerUrl,
  chainName,
  pairLabel,
  poolAddress,
  shortAddress,
} from "../src/config.js";

describe("pairLabel", () => {
  it("returns the mapped pair for a known Celo pool", () => {
    expect(pairLabel("42220-0x8c0014afe032e4574481d8934504100bf23fcb56")).toBe(
      "GBPm/USDm",
    );
  });

  it("returns the mapped pair for a known Monad pool", () => {
    expect(pairLabel("143-0x93e15a22fda39fefccce82d387a09ccf030ead61")).toBe(
      "EURm/USDm",
    );
  });

  it("falls back to the raw pool id when unknown", () => {
    expect(pairLabel("99999-0xabc")).toBe("99999-0xabc");
  });
});

describe("chainName", () => {
  it.each([
    [42220, "celo"],
    [143, "monad"],
    [11142220, "celo-sepolia"],
  ])("maps chainId %i to %s", (chainId, expected) => {
    expect(chainName(chainId)).toBe(expected);
  });

  it("falls back to stringified chainId for unknown chains", () => {
    expect(chainName(99999)).toBe("99999");
  });
});

describe("poolAddress", () => {
  it("extracts the address after the first dash", () => {
    expect(poolAddress("42220-0xdeadbeef")).toBe("0xdeadbeef");
  });

  it("takes the first dash only (later dashes are part of the address)", () => {
    expect(poolAddress("143-0xabc-suffix")).toBe("0xabc-suffix");
  });

  it("returns the input unchanged when no dash is present", () => {
    expect(poolAddress("0xbare")).toBe("0xbare");
  });

  it("returns empty string for empty input", () => {
    expect(poolAddress("")).toBe("");
  });

  it("returns empty string when the pool id ends with a dash", () => {
    expect(poolAddress("42220-")).toBe("");
  });
});

describe("shortAddress", () => {
  it("truncates a full 42-char address", () => {
    expect(shortAddress("0x93e15a22fda39fefccce82d387a09ccf030ead61")).toBe(
      "0x93e1…ad61",
    );
  });

  it("returns non-0x-prefixed input unchanged", () => {
    expect(shortAddress("not-an-address")).toBe("not-an-address");
  });

  it("returns short 0x input unchanged (below 12-char threshold)", () => {
    expect(shortAddress("0xab")).toBe("0xab");
  });

  it("returns the 11-char boundary unchanged", () => {
    expect(shortAddress("0x123456789")).toBe("0x123456789");
  });

  it("truncates at the 12-char boundary", () => {
    expect(shortAddress("0x1234567890")).toBe("0x1234…7890");
  });

  it("returns empty input unchanged", () => {
    expect(shortAddress("")).toBe("");
  });
});

describe("blockExplorerUrl", () => {
  it("builds a Celoscan URL for Celo mainnet", () => {
    expect(blockExplorerUrl(42220, "0xabc")).toBe(
      "https://celoscan.io/address/0xabc",
    );
  });

  it("builds a Monadscan URL for Monad mainnet", () => {
    expect(blockExplorerUrl(143, "0xdef")).toBe(
      "https://monadscan.com/address/0xdef",
    );
  });

  it("returns empty string for unknown chains (template guards this)", () => {
    expect(blockExplorerUrl(99999, "0xabc")).toBe("");
  });
});

describe("POOL_PAIR_LABELS", () => {
  it("covers all 11 production FPMM pools", () => {
    expect(Object.keys(POOL_PAIR_LABELS)).toHaveLength(11);
  });

  it("uses USDm-last convention for all pairs containing USDm", () => {
    for (const [id, pair] of Object.entries(POOL_PAIR_LABELS)) {
      if (pair.includes("USDm")) {
        expect(pair.endsWith("/USDm"), `${id} → ${pair}`).toBe(true);
      }
    }
  });

  it("has no pair strings containing chain prefixes or `0x` (those are fallback artifacts)", () => {
    for (const [id, pair] of Object.entries(POOL_PAIR_LABELS)) {
      expect(pair.includes("0x"), `${id} → ${pair}`).toBe(false);
      expect(pair.includes("-"), `${id} → ${pair}`).toBe(false);
    }
  });
});
