import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn().mockResolvedValue({
    user: { email: "test@mentolabs.xyz" },
  }),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn(),
  getAllLabels: vi.fn(),
}));

import { getAuthSession } from "@/auth";
import { getLabels, getAllLabels } from "@/lib/address-labels";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated
  (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: "test@mentolabs.xyz" },
  });
});

describe("GET /api/address-labels/export", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels/export");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("exports a single chain when ?chainId= is provided", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      "0xabc": { name: "Test", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
    });

    const req = new NextRequest(
      "http://localhost/api/address-labels/export?chainId=42220",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chains).toHaveProperty("42220");
    expect(body.exportedAt).toBeDefined();
    // Single-chain export does not include `global`.
    expect(body.global).toBeUndefined();
    expect(body.chains["42220"]["0xabc"].name).toBe("Test");
    expect(body.chains["42220"]["0xabc"].tags).toEqual([]);

    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("chain-42220");
    expect(getAllLabels).not.toHaveBeenCalled();
  });

  it("exports global + all chains when ?chainId is omitted", async () => {
    (getAllLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: {
        "0xggg": {
          name: "Cross-chain",
          tags: [],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
      chains: {
        "42220": {
          "0xabc": {
            name: "Mainnet",
            tags: ["Whale"],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
        "11142220": {},
      },
    });

    const req = new NextRequest("http://localhost/api/address-labels/export");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chains).toHaveProperty("42220");
    expect(body.chains).toHaveProperty("11142220");
    expect(body.global["0xggg"].name).toBe("Cross-chain");

    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("address-labels-all-");
    expect(getLabels).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid chainId", async () => {
    const req = new NextRequest(
      "http://localhost/api/address-labels/export?chainId=notanumber",
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for chainId=0", async () => {
    const req = new NextRequest(
      "http://localhost/api/address-labels/export?chainId=0",
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for chainId with scientific notation", async () => {
    // Strict decimal-only: `1e3` must not silently resolve to chainId 1000.
    const req = new NextRequest(
      "http://localhost/api/address-labels/export?chainId=1e3",
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for chainId in hex form", async () => {
    const req = new NextRequest(
      "http://localhost/api/address-labels/export?chainId=0x1",
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when getLabels throws", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Redis connection failed"),
    );
    const req = new NextRequest(
      "http://localhost/api/address-labels/export?chainId=42220",
    );
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Export failed");
  });

  it("returns 500 when getAllLabels throws", async () => {
    (getAllLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Redis unavailable"),
    );
    const req = new NextRequest("http://localhost/api/address-labels/export");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Export failed");
  });
});
