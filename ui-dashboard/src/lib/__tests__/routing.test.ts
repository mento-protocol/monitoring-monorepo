import { describe, it, expect } from "vitest";
import {
  POOL_NOT_FOUND_DEST,
  buildPoolDetailHref,
  buildPoolDetailUrl,
  buildPoolsFilterUrl,
} from "@/lib/routing";

describe("POOL_NOT_FOUND_DEST", () => {
  it("is the bare /pools route", () => {
    expect(POOL_NOT_FOUND_DEST).toBe("/pools");
  });
});

describe("buildPoolDetailHref", () => {
  it("returns /pool/<id> for namespaced pool IDs", () => {
    const poolId = "42220-0x0000000000000000000000000000000000000001";
    expect(buildPoolDetailHref(poolId)).toBe(
      `/pool/${encodeURIComponent(poolId)}`,
    );
  });

  it("returns /pool/<id> for raw pool addresses too (chain derived from context)", () => {
    const rawPoolId = "0x0000000000000000000000000000000000000001";
    expect(buildPoolDetailHref(rawPoolId)).toBe(
      `/pool/${encodeURIComponent(rawPoolId)}`,
    );
  });
});

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

  it("clears pool filter when empty string is passed", () => {
    const url = buildPoolsFilterUrl(new URLSearchParams("pool=0xold"), "", 25);
    expect(url).not.toContain("pool=");
  });
});

describe("buildPoolDetailUrl", () => {
  const poolId = "42220-0x0000000000000000000000000000000000000001";

  it("builds a bare /pool/<id> URL when no params are present", () => {
    const url = buildPoolDetailUrl(poolId, new URLSearchParams());
    expect(url).toBe(`/pool/${encodeURIComponent(poolId)}`);
  });

  it("preserves in-page params (tab, limit, search)", () => {
    const url = buildPoolDetailUrl(
      poolId,
      new URLSearchParams("tab=swaps&limit=50"),
    );
    expect(url).toContain("tab=swaps");
    expect(url).toContain("limit=50");
  });
});
