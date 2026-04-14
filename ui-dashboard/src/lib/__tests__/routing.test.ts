import { describe, it, expect } from "vitest";
import {
  buildPoolDetailHref,
  buildPoolDetailUrl,
  buildPoolNotFoundDest,
  buildPoolsFilterUrl,
} from "@/lib/routing";

// ---------------------------------------------------------------------------
// buildPoolNotFoundDest — honors the user's *active* network selection
// ---------------------------------------------------------------------------

describe("buildPoolNotFoundDest", () => {
  it("redirects to /pools (no param) for DEFAULT_NETWORK", () => {
    expect(buildPoolNotFoundDest("celo-mainnet")).toBe("/pools");
  });

  it("writes ?network= for non-default networks", () => {
    expect(buildPoolNotFoundDest("celo-sepolia")).toBe(
      "/pools?network=celo-sepolia",
    );
    expect(buildPoolNotFoundDest("monad-mainnet")).toBe(
      "/pools?network=monad-mainnet",
    );
    expect(buildPoolNotFoundDest("monad-testnet")).toBe(
      "/pools?network=monad-testnet",
    );
  });

  it("writes ?network= for non-canonical local networks", () => {
    // Local networks share chainIds with canonical ones; the active network
    // must win, not a prod-derived default.
    expect(buildPoolNotFoundDest("celo-mainnet-local")).toBe(
      "/pools?network=celo-mainnet-local",
    );
    expect(buildPoolNotFoundDest("celo-sepolia-local")).toBe(
      "/pools?network=celo-sepolia-local",
    );
    expect(buildPoolNotFoundDest("devnet")).toBe("/pools?network=devnet");
  });
});

// ---------------------------------------------------------------------------
// buildPoolDetailHref — preserves network ONLY when non-canonical
// ---------------------------------------------------------------------------

describe("buildPoolDetailHref", () => {
  const poolId = "42220-0x0000000000000000000000000000000000000001";
  const monadPoolId = "143-0x0000000000000000000000000000000000000002";

  it("omits ?network= for canonical prod networks (chainId alone resolves them)", () => {
    expect(buildPoolDetailHref(poolId, "celo-mainnet")).toBe(
      `/pool/${encodeURIComponent(poolId)}`,
    );
    expect(buildPoolDetailHref(monadPoolId, "monad-mainnet")).toBe(
      `/pool/${encodeURIComponent(monadPoolId)}`,
    );
    expect(buildPoolDetailHref(poolId, "celo-sepolia")).toBe(
      `/pool/${encodeURIComponent(poolId)}`,
    );
    expect(buildPoolDetailHref(poolId, "monad-testnet")).toBe(
      `/pool/${encodeURIComponent(poolId)}`,
    );
  });

  it("preserves ?network= for non-canonical local networks", () => {
    expect(buildPoolDetailHref(poolId, "celo-mainnet-local")).toBe(
      `/pool/${encodeURIComponent(poolId)}?network=celo-mainnet-local`,
    );
    expect(buildPoolDetailHref(poolId, "celo-sepolia-local")).toBe(
      `/pool/${encodeURIComponent(poolId)}?network=celo-sepolia-local`,
    );
    expect(buildPoolDetailHref(poolId, "devnet")).toBe(
      `/pool/${encodeURIComponent(poolId)}?network=devnet`,
    );
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

// ---------------------------------------------------------------------------
// buildPoolDetailUrl — in-page URL updates, passes ALL params through
// ---------------------------------------------------------------------------

describe("buildPoolDetailUrl", () => {
  const poolId = "42220-0x0000000000000000000000000000000000000001";

  it("builds a bare /pool/<id> URL when no params are present", () => {
    const url = buildPoolDetailUrl(poolId, new URLSearchParams());
    expect(url).toBe(`/pool/${encodeURIComponent(poolId)}`);
  });

  it("preserves non-network params (tab, limit, search)", () => {
    const url = buildPoolDetailUrl(
      poolId,
      new URLSearchParams("tab=swaps&limit=50"),
    );
    expect(url).toContain("tab=swaps");
    expect(url).toContain("limit=50");
  });

  it("preserves ?network= so non-canonical local networks stay anchored through tab/limit updates", () => {
    const url = buildPoolDetailUrl(
      poolId,
      new URLSearchParams("network=celo-mainnet-local&tab=swaps"),
    );
    expect(url).toContain("network=celo-mainnet-local");
    expect(url).toContain("tab=swaps");
  });
});
