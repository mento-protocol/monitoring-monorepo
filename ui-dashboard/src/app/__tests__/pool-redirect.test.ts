import { describe, it, expect } from "vitest";
import { buildPoolNotFoundDest } from "@/lib/routing";

/**
 * Tests for pool-not-found redirect destination logic.
 * Imports the production helper used in pool/[poolId]/page.tsx so any
 * regression in the real redirect code breaks these tests.
 */

describe("buildPoolNotFoundDest", () => {
  it("redirects to /pools when on the default network (no param)", () => {
    expect(buildPoolNotFoundDest(null)).toBe("/pools");
  });

  it("preserves ?network= for non-default networks", () => {
    expect(buildPoolNotFoundDest("celo-sepolia-hosted")).toBe(
      "/pools?network=celo-sepolia-hosted",
    );
  });

  it("preserves ?network= for monad mainnet", () => {
    expect(buildPoolNotFoundDest("monad-mainnet-hosted")).toBe(
      "/pools?network=monad-mainnet-hosted",
    );
  });

  it("encodes crafted input to prevent param injection", () => {
    const dest = buildPoolNotFoundDest("foo&pool=0xevil");
    // Should not contain a bare & that would inject a second param
    expect(dest).not.toContain("&pool=");
    expect(dest).toContain("network=");
  });
});
