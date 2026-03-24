import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

const mockSet = vi.fn().mockResolvedValue("OK");

vi.mock("@/lib/address-labels", () => ({
  getAllChainLabels: vi.fn().mockResolvedValue({
    "42220": { "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" } },
  }),
  getRedis: vi.fn(() => ({ set: mockSet })),
}));

vi.mock("crypto", () => ({
  randomUUID: () => "12345678-1234-1234-1234-123456789abc",
}));

import { getAuthSession } from "@/auth";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

describe("POST /api/address-labels/backup", () => {
  it("accepts requests with valid CRON_SECRET bearer token", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Should NOT call getAuthSession — cron token is sufficient
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("accepts requests from authenticated @mentolabs.xyz users", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 401 when neither cron token nor session is provided", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid cron token without session", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("stores backup in snapshot format compatible with import", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await POST(req);
    const storedJson = mockSet.mock.calls[0][1] as string;
    const stored = JSON.parse(storedJson);
    expect(stored).toHaveProperty("exportedAt");
    expect(stored).toHaveProperty("chains");
    expect(stored.chains).toHaveProperty("42220");
  });

  it("returns 500 when CRON_SECRET is not set in production", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("CRON_SECRET");
  });
});
