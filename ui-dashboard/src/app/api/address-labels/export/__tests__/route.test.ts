import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

vi.mock("@/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { email: "test@mentolabs.xyz" },
  }),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn(),
  getAllChainLabels: vi.fn(),
}));

import { getLabels, getAllChainLabels } from "@/lib/address-labels";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/address-labels/export", () => {
  it("exports a single chain when ?chainId= is provided", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
    });

    const req = new NextRequest(
      "http://localhost/api/address-labels/export?chainId=42220",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chains).toHaveProperty("42220");
    expect(body.exportedAt).toBeDefined();

    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("chain-42220");
    expect(getAllChainLabels).not.toHaveBeenCalled();
  });

  it("exports all chains when ?chainId is omitted", async () => {
    (getAllChainLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      "42220": {
        "0xabc": { label: "Mainnet", updatedAt: "2026-01-01T00:00:00Z" },
      },
      "11142220": {},
    });

    const req = new NextRequest("http://localhost/api/address-labels/export");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chains).toHaveProperty("42220");
    expect(body.chains).toHaveProperty("11142220");

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
    expect(body.error).toBe("Redis connection failed");
  });

  it("returns 500 when getAllChainLabels throws", async () => {
    (getAllChainLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Redis unavailable"),
    );
    const req = new NextRequest("http://localhost/api/address-labels/export");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Redis unavailable");
  });
});
