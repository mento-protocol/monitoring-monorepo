import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn().mockResolvedValue({}),
  getAllLabels: vi.fn().mockResolvedValue({ global: {}, chains: {} }),
  upsertEntry: vi.fn().mockResolvedValue(undefined),
  deleteLabel: vi.fn().mockResolvedValue(undefined),
  isArkhamSourced: (entry: { source?: string; tags?: string[] }) =>
    entry.source === "arkham" || entry.tags?.includes("arkham") === true,
}));

import { getAuthSession } from "@/auth";
import { getLabels, getAllLabels, upsertEntry } from "@/lib/address-labels";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/address-labels", () => {
  it("returns 401 when unauthenticated (chain-narrow)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest(
      "http://localhost/api/address-labels?chainId=42220",
    );
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(getLabels).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (full read)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels");
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(getAllLabels).not.toHaveBeenCalled();
  });

  it("returns all labels when authenticated (chain-narrow)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = new NextRequest(
      "http://localhost/api/address-labels?chainId=42220",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getLabels).toHaveBeenCalledWith(42220);
  });

  it("?scope=global routes to getLabels('global')", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = new NextRequest(
      "http://localhost/api/address-labels?scope=global",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getLabels).toHaveBeenCalledWith("global");
  });

  it("returns { global, chains } when no params (authenticated)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: {
        "0xggg": {
          name: "Cross-chain",
          tags: [],
          isPublic: true,
          updatedAt: "1",
        },
      },
      chains: {
        "42220": {
          "0xaaa": {
            name: "Public A",
            tags: [],
            isPublic: true,
            updatedAt: "1",
          },
          "0xbbb": {
            name: "Private B",
            tags: [],
            isPublic: false,
            updatedAt: "2",
          },
        },
        "143": {
          "0xccc": {
            name: "Monad C",
            tags: [],
            isPublic: true,
            updatedAt: "3",
          },
        },
      },
    });
    const req = new NextRequest("http://localhost/api/address-labels");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getAllLabels).toHaveBeenCalledOnce();
    const body = (await res.json()) as {
      global: Record<string, { name: string }>;
      chains: Record<string, Record<string, { name: string }>>;
    };
    expect(body.global["0xggg"].name).toBe("Cross-chain");
    expect(Object.keys(body.chains).sort()).toEqual(["143", "42220"]);
    expect(body.chains["42220"]["0xaaa"].name).toBe("Public A");
    expect(body.chains["42220"]["0xbbb"].name).toBe("Private B");
    expect(body.chains["143"]["0xccc"].name).toBe("Monad C");
  });
});

describe("PUT /api/address-labels", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        address: "0x" + "a".repeat(40),
        name: "Test",
        tags: [],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });

  it("accepts scope: 'global'", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        address,
        name: "Cross-chain",
        tags: [],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith("global", address, {
      name: "Cross-chain",
      tags: [],
      notes: undefined,
      isPublic: false,
    });
  });

  it("strips the reserved 'arkham' provenance tag from user input", async () => {
    // The arkham/enrich monthly refresh treats `tags.includes("arkham")` as
    // "safe to overwrite". A user typing "arkham" via the label editor must
    // not get their entry classified as arkham-sourced.
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: 42220,
        address,
        name: "My exchange",
        tags: ["arkham", "Arkham", "ARKHAM", "exchange"],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(42220, address, {
      name: "My exchange",
      tags: ["exchange"], // arkham (any case) stripped
      notes: undefined,
      isPublic: false,
    });
  });

  it("accepts scope: <chainId>", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: 42220,
        address,
        name: "Celo only",
        tags: [],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(42220, address, {
      name: "Celo only",
      tags: [],
      notes: undefined,
      isPublic: false,
    });
  });

  it("accepts legacy { chainId } alias", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: 42220,
        address,
        name: "Legacy client",
        tags: [],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(42220, address, {
      name: "Legacy client",
      tags: [],
      notes: undefined,
      isPublic: false,
    });
  });

  it("accepts name + tags in PUT body", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: 42220,
        address,
        name: "Wintermute",
        tags: ["Market Maker", "Arbitrageur"],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(42220, address, {
      name: "Wintermute",
      tags: ["Market Maker", "Arbitrageur"],
      notes: undefined,
      isPublic: false,
    });
  });

  it("accepts tags-only (no name) in PUT body", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: 42220,
        address,
        name: "",
        tags: ["Whale"],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
  });

  it("ignores attacker-supplied source on a previously-unlabelled row", async () => {
    // Prior state: no entry for this address. User submits `source: "arkham"`
    // in the body. The route never destructures `source` from the body, so it
    // can't promote the new entry to Arkham-sourced.
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const address = "0x" + "a".repeat(40);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        address,
        name: "Spoofed",
        tags: ["foo"],
        source: "arkham", // ignored — route never destructures `source`
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(
      "global",
      address,
      expect.not.objectContaining({ source: expect.anything() }),
    );
  });

  it("preserves existing Arkham source on edit (notes/tags update)", async () => {
    // Prior state: an Arkham-enriched entry. User edits notes/tags via the
    // dashboard — the body has no `source`, but the existing provenance must
    // survive so the entry stays in the refresh cron's candidate set.
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: {
        [address.toLowerCase()]: {
          name: "Binance Hot Wallet 14",
          tags: ["exchange"],
          source: "arkham",
          updatedAt: "2026-04-01T00:00:00Z",
        },
      },
      chains: {},
    });
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        address,
        name: "Binance Hot Wallet 14",
        tags: ["exchange", "user-curated"],
        notes: "routes the bridge fees",
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(
      "global",
      address,
      expect.objectContaining({ source: "arkham" }),
    );
  });

  it("preserves Arkham source on edit of a LEGACY entry (tag-only shape)", async () => {
    // Pre-migration entries carry `tags: ["arkham", ...]` but no `source`
    // field. Without the dual-check `isArkhamSourced`, editing such a row
    // would leave it with neither marker — invisible to the refresh cron
    // and indistinguishable from a manual entry. (Bugbot + Claude bot.)
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: {
        [address.toLowerCase()]: {
          name: "Binance",
          tags: ["arkham", "exchange"], // legacy shape
          updatedAt: "2026-04-01T00:00:00Z",
        },
      },
      chains: {},
    });
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        address,
        name: "Binance",
        tags: ["exchange"], // sentinel stripped client-side already
        notes: "edited",
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(
      "global",
      address,
      expect.objectContaining({ source: "arkham" }),
    );
  });

  it("preserves Arkham source when changing scope (chain → global)", async () => {
    // The user moves an Arkham-sourced row from chain 42220 to global. The
    // strict either/or semantics mean the entry currently lives ONLY in the
    // chain scope; looking up the target scope alone would miss it. The
    // cross-scope lookup must find it. (Codex P2 catch.)
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const address = "0x" + "a".repeat(40);
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: {},
      chains: {
        "42220": {
          [address.toLowerCase()]: {
            name: "Binance",
            tags: ["exchange"],
            source: "arkham",
            updatedAt: "2026-04-01T00:00:00Z",
          },
        },
      },
    });
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        address,
        name: "Binance",
        tags: ["exchange"],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(upsertEntry).toHaveBeenCalledWith(
      "global",
      address,
      expect.objectContaining({ source: "arkham" }),
    );
  });

  it("rejects when both name and tags are empty", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: 42220,
        address: "0x" + "a".repeat(40),
        name: "",
        tags: [],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name or tags");
  });

  it("rejects invalid scope values", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "not-a-scope",
        address: "0x" + "a".repeat(40),
        name: "x",
        tags: [],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/address-labels", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        address: "0x" + "a".repeat(40),
      }),
    });
    const res = await DELETE(req);
    expect(res.status).toBe(401);
  });
});
