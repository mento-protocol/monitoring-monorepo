import { describe, it, expect } from "vitest";
import { buildPoolNotFoundDest, buildPoolsFilterUrl } from "@/lib/routing";

// ---------------------------------------------------------------------------
// buildPoolNotFoundDest
// ---------------------------------------------------------------------------

describe("buildPoolNotFoundDest", () => {
  it("redirects to /pools when on the default network (no param)", () => {
    expect(buildPoolNotFoundDest(null)).toBe("/pools");
  });

  it("preserves ?network= for non-default networks", () => {
    expect(buildPoolNotFoundDest("celo-sepolia")).toBe(
      "/pools?network=celo-sepolia",
    );
  });

  it("preserves ?network= for monad mainnet", () => {
    expect(buildPoolNotFoundDest("monad-mainnet")).toBe(
      "/pools?network=monad-mainnet",
    );
  });

  it("encodes crafted input to prevent param injection", () => {
    const dest = buildPoolNotFoundDest("foo&pool=0xevil");
    expect(dest).not.toContain("&pool=");
    expect(dest).toContain("network=");
  });
});

// ---------------------------------------------------------------------------
// buildPoolsFilterUrl
// ---------------------------------------------------------------------------

describe("buildPoolsFilterUrl", () => {
  it("returns /pools when no filter or non-default limit", () => {
    expect(buildPoolsFilterUrl(new URLSearchParams(), "", 25)).toBe("/pools");
  });

  it("writes pool filter to /pools?pool=...", () => {
    const url = buildPoolsFilterUrl(new URLSearchParams(), "0xabc", 25);
    expect(url).toBe("/pools?pool=0xabc");
  });

  it("writes non-default limit to /pools?limit=...", () => {
    const url = buildPoolsFilterUrl(new URLSearchParams(), "", 50);
    expect(url).toBe("/pools?limit=50");
  });

  it("omits limit=25 from the URL (default)", () => {
    const url = buildPoolsFilterUrl(new URLSearchParams("limit=50"), "", 25);
    expect(url).toBe("/pools");
  });

  it("combines pool and limit", () => {
    const url = buildPoolsFilterUrl(new URLSearchParams(), "0xdef", 50);
    expect(url).toBe("/pools?pool=0xdef&limit=50");
  });

  it("preserves existing params like ?network= from currentParams", () => {
    const url = buildPoolsFilterUrl(
      new URLSearchParams("network=celo-sepolia"),
      "0xabc",
      25,
    );
    expect(url).toContain("network=celo-sepolia");
    expect(url).toContain("pool=0xabc");
    expect(url).toContain("/pools?");
  });

  it("clears pool filter when empty string is passed", () => {
    const url = buildPoolsFilterUrl(new URLSearchParams("pool=0xold"), "", 25);
    expect(url).not.toContain("pool=");
  });
});
