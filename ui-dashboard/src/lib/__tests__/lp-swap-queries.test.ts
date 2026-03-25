import { describe, it, expect } from "vitest";
import { POOL_SWAPS, RECENT_SWAPS, POOL_LP_SWAPS } from "@/lib/queries";

/**
 * Verifies the query-layer semantics introduced by the LP-trade separation PR.
 *
 * We can't easily render the pool page in a unit-test environment (it uses
 * React hooks + Next.js App Router), so we validate the GQL query strings
 * that drive the filtering and badge logic instead.
 */

describe("POOL_SWAPS / RECENT_SWAPS — excludes LP swaps", () => {
  it("POOL_SWAPS filters isLpSwap: {_eq: false}", () => {
    expect(POOL_SWAPS).toContain("isLpSwap");
    expect(POOL_SWAPS).toContain("_eq: false");
  });

  it("RECENT_SWAPS filters isLpSwap: {_eq: false}", () => {
    expect(RECENT_SWAPS).toContain("isLpSwap");
    expect(RECENT_SWAPS).toContain("_eq: false");
  });
});

describe("POOL_LP_SWAPS — targets LP swaps only", () => {
  it("POOL_LP_SWAPS filters isLpSwap: {_eq: true}", () => {
    expect(POOL_LP_SWAPS).toContain("isLpSwap");
    expect(POOL_LP_SWAPS).toContain("_eq: true");
  });

  it("POOL_LP_SWAPS accepts txHash list parameter", () => {
    expect(POOL_LP_SWAPS).toContain("txHashes");
    expect(POOL_LP_SWAPS).toContain("_in");
  });
});
