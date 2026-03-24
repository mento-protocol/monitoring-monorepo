import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn().mockResolvedValue({}),
  upsertLabel: vi.fn().mockResolvedValue(undefined),
  deleteLabel: vi.fn().mockResolvedValue(undefined),
}));

import { getAuthSession } from "@/auth";
import { getLabels } from "@/lib/address-labels";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/address-labels", () => {
  it("returns publicOnly labels when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      "0xaaa": { label: "Public", isPublic: true },
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
        label: "Test",
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
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
