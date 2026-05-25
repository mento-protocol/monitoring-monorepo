import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { BACKUP_MONITOR_MAX_RUNTIME_MINUTES, GET } from "../route";
import {
  BACKUP_MANIFEST_VERSION,
  HASH_BLOB_NAMES,
} from "@/lib/address-labels/backup-format";
import { MAX_RESTORE_BLOB_BYTES } from "@/app/api/address-labels/restore/route";

vi.mock("@sentry/nextjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/nextjs")>();
  return {
    ...actual,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    // withMonitor must still execute the wrapped callback — the tests rely
    // on the route's return value, not on the Sentry monitor side effects.
    withMonitor: vi.fn(
      async (_slug: string, cb: () => Promise<unknown>) => await cb(),
    ),
  };
});

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

// `put` returns whatever the SDK normally returns; the route only reads
// `.pathname` from us so a tiny stub is fine.
const mockPut = vi.fn().mockImplementation((pathname: string) =>
  Promise.resolve({
    pathname,
    url: `https://blob.vercel-storage.com/${pathname}`,
  }),
);

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

/**
 * Helper: pull the per-blob put() calls into a name → content map for assertion.
 * Excludes the manifest blob so tests can compare each hash blob's body.
 */
function hashBlobContents(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const call of mockPut.mock.calls) {
    const [pathname, content] = call as [string, string];
    if (pathname.endsWith("/manifest.json")) continue;
    const fileName = pathname.split("/").pop() ?? pathname;
    const name = fileName.replace(/\.json$/, "");
    out[name] = content;
  }
  return out;
}

function manifestBody(): { pathname: string; content: string } {
  const manifestCall = mockPut.mock.calls.find(([p]) =>
    String(p).endsWith("/manifest.json"),
  );
  if (!manifestCall) throw new Error("No manifest blob was written");
  return {
    pathname: manifestCall[0] as string,
    content: manifestCall[1] as string,
  };
}

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

  it("configures the Sentry monitor to fail within the function runtime budget", async () => {
    const Sentry = await import("@sentry/nextjs");
    const withMonitor = vi.mocked(Sentry.withMonitor);

    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    expect(withMonitor).toHaveBeenCalledWith(
      "address-labels-backup",
      expect.any(Function),
      expect.objectContaining({
        maxRuntime: BACKUP_MONITOR_MAX_RUNTIME_MINUTES,
      }),
    );
    expect(BACKUP_MONITOR_MAX_RUNTIME_MINUTES).toBe(5);
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

  it("writes 7 hash blobs + manifest under date prefix (v2 per-hash splits)", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    // 7 hash blobs + 1 manifest = 8 put() calls
    expect(mockPut).toHaveBeenCalledTimes(8);

    // Every blob pathname follows the v2 per-day prefix convention.
    // Hash blobs use addRandomSuffix: true so each run writes unique paths
    // (no torn snapshots on retry); the manifest stays at a deterministic
    // per-day path so restore has a single known entry point.
    for (const call of mockPut.mock.calls) {
      const [pathname, , opts] = call as [
        string,
        unknown,
        Record<string, unknown>,
      ];
      expect(pathname).toMatch(
        /^address-labels-backup-\d{4}-\d{2}-\d{2}\/(labels|reports|intelDeep|intelTransfers|intelWealth|intelEntities|intelEntityCps|manifest)\.json$/,
      );
      expect(opts.access).toBe("private");
      if (pathname.endsWith("/manifest.json")) {
        expect(opts.addRandomSuffix).toBe(false);
        expect(opts.allowOverwrite).toBe(true);
      } else {
        expect(opts.addRandomSuffix).toBe(true);
      }
    }

    // Every named hash blob landed
    const hashContents = hashBlobContents();
    for (const name of HASH_BLOB_NAMES) {
      expect(hashContents).toHaveProperty(name);
    }
  });

  it("manifest blob lists every hash with pathname + sizeBytes", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    const { content } = manifestBody();
    const manifest = JSON.parse(content);
    expect(manifest.version).toBe(BACKUP_MANIFEST_VERSION);
    expect(typeof manifest.exportedAt).toBe("string");
    expect(manifest.hashes).toHaveLength(HASH_BLOB_NAMES.length);
    for (const entry of manifest.hashes) {
      expect(HASH_BLOB_NAMES).toContain(entry.name);
      expect(typeof entry.pathname).toBe("string");
      expect(typeof entry.sizeBytes).toBe("number");
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("labels blob holds the address records (not the snapshot envelope)", async () => {
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    const stored = JSON.parse(hashBlobContents().labels);
    expect(stored["0xggg"].name).toBe("Cross-chain");
    expect(stored["0xabc"].name).toBe("Test");
    // The per-hash blob is just the records map; no `addresses` /
    // `exportedAt` / `reports` envelope (those live in the manifest and in
    // the other per-hash blobs).
    expect(stored).not.toHaveProperty("addresses");
    expect(stored).not.toHaveProperty("exportedAt");
    expect(stored).not.toHaveProperty("reports");
  });

  it("reports blob holds forensic reports verbatim", async () => {
    // Restore parity: a Redis flush would otherwise lose every forensic
    // report in the same Upstash instance. The per-hash split puts each
    // hash type in its own blob, but the records are the same JSON shape
    // the import path consumes.
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    const stored = JSON.parse(hashBlobContents().reports);
    expect(stored["0xabc"]).toEqual({
      body: "Suspected MEV operator. See thread.",
      title: "Investigation",
      authorEmail: "alice@mentolabs.xyz",
      source: "manual",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-30T00:00:00Z",
      version: 3,
    });
  });

  it("emits an empty reports blob when no reports exist (not omitted)", async () => {
    // Always-present blob keeps the manifest shape stable for restore
    // tooling — every manifest lists all 7 hashes, even when one is empty.
    (getAllReports as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    await GET(req);

    const reportsBlob = JSON.parse(hashBlobContents().reports);
    expect(reportsBlob).toEqual({});
    // Manifest still includes the reports entry.
    const manifest = JSON.parse(manifestBody().content);
    expect(manifest.hashes.map((h: { name: string }) => h.name)).toContain(
      "reports",
    );
  });

  it("manifest pathname is deterministic across same-day runs (restore entry point stays stable)", async () => {
    // Hash blobs use addRandomSuffix: true so each run writes unique paths
    // (real Vercel appends a random token; our mock returns input unchanged
    // so the test can't directly observe the suffix). What MUST stay stable
    // is the manifest pathname — restore looks it up by per-day prefix.
    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res1 = await GET(req);
    const { pathname: manifest1 } = await res1.json();
    mockPut.mockClear();
    const res2 = await GET(req);
    const { pathname: manifest2 } = await res2.json();
    expect(manifest1).toBe(manifest2);
    expect(manifest1).toMatch(
      /^address-labels-backup-\d{4}-\d{2}-\d{2}\/manifest\.json$/,
    );
  });

  it("fires a Sentry warning when any single hash blob exceeds the restore cap", async () => {
    // Regression test: a hash whose serialised JSON crosses
    // MAX_RESTORE_BLOB_BYTES would make every restore from that snapshot
    // 413 — backup still succeeds (raw blob is salvageable) but the
    // captureMessage warning makes the impending DR break visible.
    const Sentry = await import("@sentry/nextjs");
    const captureMessage = vi.mocked(Sentry.captureMessage);

    // Build a record whose JSON-serialised form exceeds the cap.
    const oneMb = "x".repeat(1024 * 1024);
    const fatRecords: Record<string, string> = {};
    for (let i = 0; i < MAX_RESTORE_BLOB_BYTES / (1024 * 1024) + 2; i++) {
      fatRecords[`field${i}`] = oneMb;
    }
    const { getAllIntelDeep } = await import("@/lib/intel-deep");
    (getAllIntelDeep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fatRecords,
    );

    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const warningCall = captureMessage.mock.calls.find((args) =>
      String(args[0]).includes("intelDeep"),
    );
    expect(warningCall).toBeDefined();
    expect(warningCall![0]).toMatch(/exceeds restore cap/);
    expect(warningCall![1]).toMatchObject({ level: "warning" });
  });

  it("fires a Sentry warning when any single field's wire size exceeds the chunked-HSET cap", async () => {
    // Regression test: a sub-16MB blob can still deterministically fail
    // restore if one field/value pair exceeds the chunked-HSET budget.
    // chunkedHashWrite pre-scans + throws on the first unsplittable field
    // before any write — backup needs to warn at preflight time.
    const Sentry = await import("@sentry/nextjs");
    const captureMessage = vi.mocked(Sentry.captureMessage);

    // Single field whose JSON-encoded value exceeds the chunk cap. Other
    // fields are tiny, so the blob itself fits under 16 MB and the per-blob
    // check wouldn't fire — only the per-field guard catches this.
    const huge = "Q".repeat(8 * 1024 * 1024 + 1024);
    const fatFields: Record<string, string> = { onefatfield: huge };
    const { getAllIntelDeep } = await import("@/lib/intel-deep");
    (getAllIntelDeep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fatFields,
    );

    const req = new NextRequest("http://localhost/api/address-labels/backup", {
      method: "GET",
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const warningCall = captureMessage.mock.calls.find((args) =>
      String(args[0]).includes("unsplittable field"),
    );
    expect(warningCall).toBeDefined();
    expect(warningCall![0]).toMatch(/onefatfield/);
    expect(warningCall![0]).toMatch(/chunked-HSET cap/);
    expect(warningCall![1]).toMatchObject({ level: "warning" });
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
