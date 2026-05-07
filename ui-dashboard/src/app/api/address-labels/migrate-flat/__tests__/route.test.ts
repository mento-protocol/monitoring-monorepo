import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  put: vi.fn().mockResolvedValue({
    pathname: "address-labels-pre-migrate-flat-2026-05-07.json",
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/address-labels", async () => {
  const shared = await vi.importActual<
    typeof import("@/lib/address-labels-shared")
  >("@/lib/address-labels-shared");
  return {
    ...shared,
    readLegacyScopes: vi.fn(),
    importLabels: vi.fn().mockResolvedValue(undefined),
    getLabelsByAddress: vi.fn(),
    dropLegacyScopes: vi.fn().mockResolvedValue(undefined),
  };
});

import { POST } from "../route";
import { getAuthSession } from "@/auth";
import { put } from "@vercel/blob";
import {
  dropLegacyScopes,
  getLabelsByAddress,
  importLabels,
  readLegacyScopes,
} from "@/lib/address-labels";

const mockGetAuthSession = vi.mocked(getAuthSession);
const mockReadLegacyScopes = vi.mocked(readLegacyScopes);
const mockImportLabels = vi.mocked(importLabels);
const mockGetLabelsByAddress = vi.mocked(getLabelsByAddress);
const mockDropLegacyScopes = vi.mocked(dropLegacyScopes);
const mockPut = vi.mocked(put);

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mockPut.mockResolvedValue({
    pathname: "address-labels-pre-migrate-flat-2026-05-07.json",
  } as Awaited<ReturnType<typeof put>>);
  mockImportLabels.mockResolvedValue(undefined);
  mockDropLegacyScopes.mockResolvedValue(undefined);
});

function makeReq(
  opts: {
    bearer?: string;
    dryRun?: boolean;
  } = {},
): NextRequest {
  const url = new URL("http://localhost/api/address-labels/migrate-flat");
  if (opts.dryRun) url.searchParams.set("dryRun", "true");
  return new NextRequest(url, {
    method: "POST",
    headers: opts.bearer
      ? { authorization: `Bearer ${opts.bearer}` }
      : undefined,
  });
}

describe("POST /api/address-labels/migrate-flat — auth", () => {
  it("returns 401 without bearer or session", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(mockReadLegacyScopes).not.toHaveBeenCalled();
  });

  it("accepts a valid CRON_SECRET bearer", async () => {
    mockReadLegacyScopes.mockResolvedValue({ legacyKeys: [], scopes: [] });
    const res = await POST(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
  });

  it("rejects a wrong bearer (without session)", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    const res = await POST(makeReq({ bearer: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("rejects a session with a non-mentolabs.xyz email", async () => {
    mockGetAuthSession.mockResolvedValue({
      user: { email: "alice@gmail.com" },
      expires: "2099-01-01T00:00:00Z",
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
  });

  it("accepts a session with a @mentolabs.xyz email", async () => {
    mockGetAuthSession.mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
      expires: "2099-01-01T00:00:00Z",
    });
    mockReadLegacyScopes.mockResolvedValue({ legacyKeys: [], scopes: [] });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await POST(makeReq({ bearer: "anything" }));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/address-labels/migrate-flat — no-op when no legacy keys", () => {
  it("returns clean no-op without writing or backing up", async () => {
    mockReadLegacyScopes.mockResolvedValue({ legacyKeys: [], scopes: [] });
    const res = await POST(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.legacyScopes).toBe(0);
    expect(body.written).toBe(0);
    expect(body.legacyDropped).toBe(false);
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockImportLabels).not.toHaveBeenCalled();
    expect(mockDropLegacyScopes).not.toHaveBeenCalled();
  });
});

describe("POST /api/address-labels/migrate-flat — dryRun", () => {
  it("returns the merge plan without writing, backing up, or dropping", async () => {
    mockReadLegacyScopes.mockResolvedValue({
      legacyKeys: ["labels:42220"],
      scopes: [
        {
          key: "labels:42220",
          entries: {
            "0xaaa": {
              name: "Alice",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
      ],
    });
    const res = await POST(makeReq({ bearer: "cron-secret", dryRun: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      legacyScopes: number;
      legacyEntries: number;
      written: number;
      legacyDropped: boolean;
    };
    expect(body.legacyScopes).toBe(1);
    expect(body.legacyEntries).toBe(1);
    expect(body.written).toBe(0);
    expect(body.legacyDropped).toBe(false);
    // Critical: no Blob write on dry runs.
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockImportLabels).not.toHaveBeenCalled();
    expect(mockDropLegacyScopes).not.toHaveBeenCalled();
  });
});

describe("POST /api/address-labels/migrate-flat — live success", () => {
  it("backs up, imports, verifies, then drops legacy keys", async () => {
    mockReadLegacyScopes.mockResolvedValue({
      legacyKeys: ["labels:42220", "labels:global"],
      scopes: [
        {
          key: "labels:42220",
          entries: {
            "0xaaa": {
              name: "Alice",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
        {
          key: "labels:global",
          entries: {
            "0xbbb": {
              name: "Bob",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
      ],
    });
    // Verification: every address landed.
    mockGetLabelsByAddress.mockResolvedValue([
      { name: "Alice", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      { name: "Bob", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
    ]);

    const res = await POST(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      written: number;
      legacyDropped: boolean;
      backupPathname?: string;
    };
    expect(body.written).toBe(2);
    expect(body.legacyDropped).toBe(true);
    expect(body.backupPathname).toBeTruthy();
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockImportLabels).toHaveBeenCalledTimes(1);
    expect(mockDropLegacyScopes).toHaveBeenCalledWith([
      "labels:42220",
      "labels:global",
    ]);
  });

  it("backup uses the importable AddressLabelsSnapshot shape (global + chains)", async () => {
    mockReadLegacyScopes.mockResolvedValue({
      legacyKeys: ["labels:global", "labels:42220"],
      scopes: [
        {
          key: "labels:global",
          entries: {
            "0xggg": {
              name: "Global",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
        {
          key: "labels:42220",
          entries: {
            "0xaaa": {
              name: "Celo",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
      ],
    });
    mockGetLabelsByAddress.mockResolvedValue([
      { name: "Global", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      { name: "Celo", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
    ]);

    await POST(makeReq({ bearer: "cron-secret" }));
    const [, content] = mockPut.mock.calls[0];
    const snapshot = JSON.parse(content as string);
    expect(snapshot.exportedAt).toBeTruthy();
    expect(snapshot.global["0xggg"].name).toBe("Global");
    expect(snapshot.chains["42220"]["0xaaa"].name).toBe("Celo");
  });
});

describe("POST /api/address-labels/migrate-flat — verification failure", () => {
  it("throws + leaves legacy keys intact when an address is missing post-write", async () => {
    mockReadLegacyScopes.mockResolvedValue({
      legacyKeys: ["labels:42220"],
      scopes: [
        {
          key: "labels:42220",
          entries: {
            "0xaaa": {
              name: "Alice",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
      ],
    });
    mockGetLabelsByAddress.mockResolvedValue([null]); // verification: missing

    const res = await POST(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/verification failed/);
    // Critical: legacy keys must NOT be dropped if verification fails —
    // the backup is the only remaining recovery path.
    expect(mockDropLegacyScopes).not.toHaveBeenCalled();
  });
});

describe("POST /api/address-labels/migrate-flat — conflict resolution", () => {
  it("merges multi-source addresses + records them as conflicts", async () => {
    mockReadLegacyScopes.mockResolvedValue({
      legacyKeys: ["labels:42220", "labels:global"],
      scopes: [
        {
          key: "labels:42220",
          entries: {
            "0xaaa": {
              name: "Older Alice",
              tags: ["old"],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
        {
          key: "labels:global",
          entries: {
            "0xaaa": {
              name: "Newer Alice",
              tags: ["new"],
              updatedAt: "2026-04-01T00:00:00Z",
            },
          },
        },
      ],
    });
    mockGetLabelsByAddress.mockResolvedValue([
      { name: "Newer Alice", tags: [], updatedAt: "2026-04-01T00:00:00Z" },
    ]);

    const res = await POST(makeReq({ bearer: "cron-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conflicts: Array<{ address: string; sources: string[] }>;
      written: number;
    };
    expect(body.written).toBe(1);
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].address).toBe("0xaaa");
    expect(body.conflicts[0].sources.sort()).toEqual([
      "labels:42220",
      "labels:global",
    ]);

    // The merged value passed to importLabels should be the newer entry's
    // name + the union of tags.
    const [labels] = mockImportLabels.mock.calls[0];
    const merged = (labels as Record<string, { name: string; tags: string[] }>)[
      "0xaaa"
    ];
    expect(merged.name).toBe("Newer Alice");
    expect(merged.tags.sort()).toEqual(["new", "old"]);
  });

  it("tag-only newer entry preserves empty name (does not resurrect older name)", async () => {
    // Regression for the `newer.name || older.name` truthiness fallback.
    mockReadLegacyScopes.mockResolvedValue({
      legacyKeys: ["labels:42220", "labels:global"],
      scopes: [
        {
          key: "labels:42220",
          entries: {
            "0xaaa": {
              name: "Stale Old Name",
              tags: [],
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
        {
          key: "labels:global",
          entries: {
            "0xaaa": {
              name: "",
              tags: ["whale"],
              updatedAt: "2026-04-01T00:00:00Z",
            },
          },
        },
      ],
    });
    mockGetLabelsByAddress.mockResolvedValue([
      { name: "", tags: ["whale"], updatedAt: "2026-04-01T00:00:00Z" },
    ]);

    await POST(makeReq({ bearer: "cron-secret" }));
    const [labels] = mockImportLabels.mock.calls[0];
    const merged = (labels as Record<string, { name: string; tags: string[] }>)[
      "0xaaa"
    ];
    expect(merged.name).toBe(""); // newer wins, even if empty
    expect(merged.tags.sort()).toEqual(["whale"]);
  });
});
