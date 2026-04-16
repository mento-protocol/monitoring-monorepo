import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn().mockResolvedValue({}),
  getAllChainLabels: vi.fn().mockResolvedValue({}),
  upsertEntry: vi.fn().mockResolvedValue(undefined),
  deleteLabel: vi.fn().mockResolvedValue(undefined),
}));

import { getAuthSession } from "@/auth";
import {
  getLabels,
  getAllChainLabels,
  upsertEntry,
} from "@/lib/address-labels";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/address-labels", () => {
  it("returns publicOnly labels when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      "0xaaa": { name: "Public", tags: [], isPublic: true },
    });
    const req = new NextRequest(
      "http://localhost/api/address-labels?chainId=42220",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getLabels).toHaveBeenCalledWith(42220, { publicOnly: true });
  });

  it("returns all labels when authenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = new NextRequest(
      "http://localhost/api/address-labels?chainId=42220",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getLabels).toHaveBeenCalledWith(42220, { publicOnly: false });
  });

  it("returns cross-chain labels when no chainId is provided (authenticated)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getAllChainLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    });
    const req = new NextRequest("http://localhost/api/address-labels");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getAllChainLabels).toHaveBeenCalledOnce();
    const body = (await res.json()) as Record<
      string,
      Record<string, { name: string }>
    >;
    expect(Object.keys(body).sort()).toEqual(["143", "42220"]);
    expect(body["42220"]["0xaaa"].name).toBe("Public A");
    expect(body["42220"]["0xbbb"].name).toBe("Private B");
    expect(body["143"]["0xccc"].name).toBe("Monad C");
  });

  it("filters to public-only cross-chain entries when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getAllChainLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      "42220": {
        "0xaaa": {
          name: "Public",
          tags: [],
          isPublic: true,
          updatedAt: "1",
        },
        "0xbbb": {
          name: "Private",
          tags: [],
          isPublic: false,
          updatedAt: "2",
        },
      },
    });
    const req = new NextRequest("http://localhost/api/address-labels");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<
      string,
      Record<string, { name: string }>
    >;
    expect(Object.keys(body["42220"])).toEqual(["0xaaa"]);
  });
});

describe("PUT /api/address-labels", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: 42220,
        address: "0x" + "a".repeat(40),
        name: "Test",
        tags: [],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
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
        chainId: 42220,
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
        chainId: 42220,
        address,
        name: "",
        tags: ["Whale"],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
  });

  it("rejects when both name and tags are empty", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: 42220,
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
});

describe("DELETE /api/address-labels", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: 42220,
        address: "0x" + "a".repeat(40),
      }),
    });
    const res = await DELETE(req);
    expect(res.status).toBe(401);
  });
});
