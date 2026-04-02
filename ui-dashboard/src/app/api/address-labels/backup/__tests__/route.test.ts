import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  getAllChainLabels: vi.fn().mockResolvedValue({
    "42220": {
      "0xabc": { name: "Test", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
    },
  }),
}));

const mockPut = vi.fn().mockResolvedValue({
  pathname: "address-labels-backup-2026-03-24.json",
  url: "https://blob.vercel-storage.com/address-labels-backup-2026-03-24.json",
});

vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]) => mockPut(...args),
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

  it("stores backup as private Vercel Blob in snapshot format", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await POST(req);

    expect(mockPut).toHaveBeenCalledTimes(1);
    const [filename, content, opts] = mockPut.mock.calls[0];
    expect(filename).toMatch(/^address-labels-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(opts.access).toBe("private");
    expect(opts.addRandomSuffix).toBe(false);

    const stored = JSON.parse(content as string);
    expect(stored).toHaveProperty("exportedAt");
    expect(stored).toHaveProperty("chains");
    expect(stored.chains).toHaveProperty("42220");
    // Verify v2 schema in backup
    expect(stored.chains["42220"]["0xabc"].name).toBe("Test");
    expect(stored.chains["42220"]["0xabc"].tags).toEqual([]);
  });

  it("overwrites same-day backup (deterministic filename)", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "POST",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await POST(req);
    await POST(req);
    const name1 = mockPut.mock.calls[0][0] as string;
    const name2 = mockPut.mock.calls[1][0] as string;
    expect(name1).toBe(name2);
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
