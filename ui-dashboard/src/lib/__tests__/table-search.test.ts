import { describe, expect, it } from "vitest";
import {
  buildSearchBlob,
  matchesSearch,
  normalizeSearch,
} from "@/lib/table-search";

describe("table-search helpers", () => {
  it("normalizes search queries by trimming and lowercasing", () => {
    expect(normalizeSearch("  HeLLo WoRLD  ")).toBe("hello world");
  });

  it("drops nullish and empty search terms when building blobs", () => {
    expect(buildSearchBlob(["alpha", null, undefined, "", "beta"])).toBe(
      "alpha\nbeta",
    );
  });

  it("matches a full address even when the UI would display it truncated", () => {
    const address = "0x1234567890abcdef1234567890abcdef1234abcd";
    const blob = buildSearchBlob([address]);

    expect(matchesSearch(blob, normalizeSearch(address))).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("0x123456"))).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("1234567890abcdef"))).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("1234abcd"))).toBe(true);
  });

  it("matches resolved labels as well as raw addresses", () => {
    const blob = buildSearchBlob([
      "0x1234567890abcdef1234567890abcdef1234abcd",
      "Treasury Wallet",
    ]);

    expect(matchesSearch(blob, normalizeSearch("treasury"))).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("wallet"))).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("0x1234567890ab"))).toBe(true);
  });

  it("matches checksum addresses case-insensitively", () => {
    const blob = buildSearchBlob([
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "Vitalik",
    ]);

    expect(
      matchesSearch(
        blob,
        normalizeSearch("0xD8DA6bf26964AF9D7EED9E03E53415d37AA96045"),
      ),
    ).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("vitalik"))).toBe(true);
  });

  it("matches tx hash fragments even when the UI truncates the hash", () => {
    const txHash =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const blob = buildSearchBlob([txHash]);

    expect(matchesSearch(blob, normalizeSearch("0xabcdef"))).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("1234567890abcdef"))).toBe(true);
    expect(matchesSearch(blob, normalizeSearch("567890"))).toBe(true);
  });

  it("returns true for an empty query", () => {
    expect(matchesSearch("anything", "")).toBe(true);
  });

  it("returns false when no term contains the query", () => {
    const blob = buildSearchBlob(["mint", "alice", "1,234.00", "100"]);
    expect(matchesSearch(blob, normalizeSearch("burn"))).toBe(false);
  });
});
