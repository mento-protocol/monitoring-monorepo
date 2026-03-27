import { describe, it, expect } from "vitest";
import {
  isNamespacedPoolId,
  extractChainIdFromPoolId,
  normalizePoolIdForChain,
} from "../pool-id";

// ---------------------------------------------------------------------------
// isNamespacedPoolId
// ---------------------------------------------------------------------------
describe("isNamespacedPoolId", () => {
  it("accepts valid namespaced IDs", () => {
    expect(
      isNamespacedPoolId("42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
    ).toBe(true);
    expect(
      isNamespacedPoolId("143-0xBC69212B8E4D445B2307C9D32Dd68E2A4Df00115"),
    ).toBe(true);
    // single-digit chainId (edge case)
    expect(
      isNamespacedPoolId("1-0xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
    ).toBe(true);
  });

  it("rejects raw addresses", () => {
    expect(
      isNamespacedPoolId("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
    ).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isNamespacedPoolId("")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isNamespacedPoolId("garbage")).toBe(false);
    expect(isNamespacedPoolId("42220-garbage")).toBe(false);
    // too short (not 40 hex chars)
    expect(isNamespacedPoolId("42220-0xabc")).toBe(false);
  });

  it("rejects uppercase 0X prefix", () => {
    expect(
      isNamespacedPoolId("42220-0Xd8da6bf26964af9d7eed9e03e53415d37aa96045"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractChainIdFromPoolId
// ---------------------------------------------------------------------------
describe("extractChainIdFromPoolId", () => {
  it("extracts chainId from a namespaced pool ID", () => {
    expect(
      extractChainIdFromPoolId(
        "42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      ),
    ).toBe(42220);
    expect(
      extractChainIdFromPoolId(
        "143-0xBC69212B8E4D445B2307C9D32Dd68E2A4Df00115",
      ),
    ).toBe(143);
  });

  it("returns null for raw addresses", () => {
    expect(
      extractChainIdFromPoolId("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractChainIdFromPoolId("")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(extractChainIdFromPoolId("garbage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizePoolIdForChain
// ---------------------------------------------------------------------------
describe("normalizePoolIdForChain", () => {
  it("prefixes a raw address with chainId", () => {
    expect(
      normalizePoolIdForChain(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        42220,
      ),
    ).toBe("42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
  });

  it("lowercases an already-namespaced pool ID", () => {
    expect(
      normalizePoolIdForChain(
        "143-0xBC69212B8E4D445B2307C9D32Dd68E2A4Df00115",
        42220,
      ),
    ).toBe("143-0xbc69212b8e4d445b2307c9d32dd68e2a4df00115");
  });

  it("preserves the original chainId when already namespaced (cross-chain passthrough)", () => {
    // A pool from chain 143 passed while network is 42220 — ID stays as 143-0x...
    expect(
      normalizePoolIdForChain(
        "143-0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        42220,
      ),
    ).toBe("143-0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
  });

  it("returns garbage input unchanged (passthrough is intentional)", () => {
    // Callers either pre-validate (pools page applyFilter) or rely on the
    // resulting not-found redirect (pool detail page URL). The passthrough is
    // a documented, intentional design choice.
    expect(normalizePoolIdForChain("garbage", 42220)).toBe("garbage");
    expect(normalizePoolIdForChain("", 42220)).toBe("");
  });

  it("lowercases the address portion of a raw 0x address", () => {
    expect(
      normalizePoolIdForChain(
        "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045",
        42220,
      ),
    ).toBe("42220-0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
  });
});
