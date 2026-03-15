import { describe, it, expect } from "vitest";

/**
 * Unit tests for the pool-not-found redirect destination logic.
 * Extracted from pool/[poolId]/page.tsx for isolated testing.
 *
 * Logic: when a pool is not found on the current network, redirect to
 * /pools while preserving the active ?network= param so the user lands
 * on the correct chain rather than the default.
 */

function poolNotFoundRedirectDest(networkParam: string | null): string {
  return networkParam ? `/pools?network=${networkParam}` : "/pools";
}

describe("pool not-found redirect destination", () => {
  it("redirects to /pools when on the default network (no param)", () => {
    expect(poolNotFoundRedirectDest(null)).toBe("/pools");
  });

  it("preserves ?network= for non-default networks", () => {
    expect(poolNotFoundRedirectDest("celo-sepolia-hosted")).toBe(
      "/pools?network=celo-sepolia-hosted",
    );
  });

  it("preserves ?network= for monad mainnet", () => {
    expect(poolNotFoundRedirectDest("monad-mainnet-hosted")).toBe(
      "/pools?network=monad-mainnet-hosted",
    );
  });
});
