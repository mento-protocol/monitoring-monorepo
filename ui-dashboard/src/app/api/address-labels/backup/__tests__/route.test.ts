import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn().mockResolvedValue({
    "0xggg": {
      name: "Cross-chain",
      tags: [],
      updatedAt: "2026-01-01T00:00:00Z",
    },
    "0xabc": { name: "Test", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
  }),
}));

vi.mock("@/lib/address-reports", () => ({
  getAllReports: vi.fn().mockResolvedValue({
    "0xabc": {
      body: "Suspected MEV operator. See thread.",
      title: "Investigation",
      authorEmail: "alice@mentolabs.xyz",
      source: "manual",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-30T00:00:00Z",
      version: 3,
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

vi.mock("@/lib/intel-deep", () => ({
  getAllIntelDeep: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/intel-transfers", () => ({
  getAllIntelTransfers: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/intel-wealth", () => ({
  getAllIntelWealth: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/intel-entities", () => ({
  getAllIntelEntities: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/intel-entity-cps", () => ({
  getAllIntelEntityCps: vi.fn().mockResolvedValue({}),
}));

import { getAuthSession } from "@/auth";
import { getAllReports } from "@/lib/address-reports";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  // Reset to the default report fixture each run — individual tests override
  // when they need the empty-hash branch.
  (getAllReports as ReturnType<typeof vi.fn>).mockResolvedValue({
    "0xabc": {
      body: "Suspected MEV operator. See thread.",
      title: "Investigation",
      authorEmail: "alice@mentolabs.xyz",
      source: "manual",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-30T00:00:00Z",
      version: 3,
    },
  });
});

describe("GET /api/address-labels/backup", () => {
  it("accepts requests with valid CRON_SECRET bearer token", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("401s on session-only auth — bearer required for cron GET (CSRF defence)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when neither cron token nor session is provided", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid cron token without session", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("stores backup as private Vercel Blob in flat snapshot format", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    expect(mockPut).toHaveBeenCalledTimes(1);
    const [filename, content, opts] = mockPut.mock.calls[0];
    expect(filename).toMatch(/^address-labels-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(opts.access).toBe("private");
    expect(opts.addRandomSuffix).toBe(false);

    const stored = JSON.parse(content as string);
    expect(stored).toHaveProperty("exportedAt");
    expect(stored).toHaveProperty("addresses");
    expect(stored.addresses["0xggg"].name).toBe("Cross-chain");
    expect(stored.addresses["0xabc"].name).toBe("Test");
    // Legacy snapshot fields no longer emitted.
    expect(stored.global).toBeUndefined();
    expect(stored.chains).toBeUndefined();
  });

  it("embeds forensic reports under the `reports` key alongside addresses", async () => {
    // Restore parity: a Redis flush would otherwise lose every forensic
    // report in the same Upstash instance. The wire-format key is `reports`
    // (NOT `addressReports`) — keep this assertion exact, matching the
    // import path's expected shape.
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    const [, content] = mockPut.mock.calls[0];
    const stored = JSON.parse(content as string);
    expect(stored).toHaveProperty("reports");
    expect(stored.reports).not.toHaveProperty("addressReports");
    expect(stored.reports["0xabc"]).toEqual({
      body: "Suspected MEV operator. See thread.",
      title: "Investigation",
      authorEmail: "alice@mentolabs.xyz",
      source: "manual",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-30T00:00:00Z",
      version: 3,
    });
  });

  it("emits an empty `reports` object when no reports exist (not omitted)", async () => {
    // Always-present key keeps the wire format stable for restore tooling
    // — a downstream tool checking `snapshot.reports` shouldn't have to
    // distinguish "not yet backfilled" from "no reports yet".
    (getAllReports as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    const [, content] = mockPut.mock.calls[0];
    const stored = JSON.parse(content as string);
    expect(stored.reports).toEqual({});
  });

  it("overwrites same-day backup (deterministic filename)", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);
    await GET(req);
    const name1 = mockPut.mock.calls[0][0] as string;
    const name2 = mockPut.mock.calls[1][0] as string;
    expect(name1).toBe(name2);
  });

  it("returns 500 when CRON_SECRET is not set in production", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
    });
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("CRON_SECRET");
  });
});
