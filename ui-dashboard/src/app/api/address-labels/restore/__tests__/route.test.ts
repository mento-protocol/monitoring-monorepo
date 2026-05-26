import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/address-labels/snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/address-labels/snapshot")
  >("@/lib/address-labels/snapshot");
  return {
    ...actual,
    isSnapshot: vi.fn(() => true),
    handleSnapshot: vi.fn(async () =>
      Response.json({ ok: true, imported: { addresses: 1 } }),
    ),
  };
});

import { getAuthSession } from "@/auth";
import * as Sentry from "@sentry/nextjs";
import { get } from "@vercel/blob";
import { handleSnapshot, isSnapshot } from "@/lib/address-labels/snapshot";
import { MAX_RESTORE_BLOB_BYTES, POST } from "../route";
import { BACKUP_MANIFEST_VERSION } from "@/lib/address-labels/backup-format";

const mockGetAuthSession = vi.mocked(getAuthSession);
const mockGet = vi.mocked(get);
const mockCaptureException = vi.mocked(Sentry.captureException);
const mockHandleSnapshot = vi.mocked(handleSnapshot);
const mockIsSnapshot = vi.mocked(isSnapshot);
const RESTORE_LIMIT = MAX_RESTORE_BLOB_BYTES;

function req(
  pathname = "address-labels-backup-2026-05-11.json",
  headers?: HeadersInit,
): NextRequest {
  const url = new URL("http://localhost/api/address-labels/restore");
  if (pathname) url.searchParams.set("pathname", pathname);
  return new NextRequest(url, { method: "POST", headers });
}

function blobResult(body: unknown, size?: number | null) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    statusCode: 200,
    stream: new Response(text).body,
    blob: {
      size: size === undefined ? Buffer.byteLength(text, "utf8") : size,
    },
  };
}

function streamBlobResult(stream: ReadableStream<Uint8Array>) {
  return {
    statusCode: 200,
    stream,
    headers: new Headers(),
    blob: { size: null },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "secret");
  mockGetAuthSession.mockResolvedValue(null);
  mockGet.mockResolvedValue(
    blobResult({ addresses: {} }) as Awaited<ReturnType<typeof get>>,
  );
  mockIsSnapshot.mockReturnValue(true);
  mockHandleSnapshot.mockResolvedValue(
    Response.json({ ok: true, imported: { addresses: 1 } }) as Awaited<
      ReturnType<typeof handleSnapshot>
    >,
  );
});

describe("POST /api/address-labels/restore — common auth + pathname rejects", () => {
  it("requires bearer or workspace-session auth", async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("allows a workspace session and lowercases the restore actor email", async () => {
    mockGetAuthSession.mockResolvedValue({
      user: { email: "Alice@MentoLabs.xyz" },
      expires: "2026-12-31T00:00:00.000Z",
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockHandleSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ importerEmail: "alice@mentolabs.xyz" }),
    );
  });

  it("rejects unsupported pathnames before touching Blob", async () => {
    const res = await POST(
      req("../secret.json", { authorization: "Bearer secret" }),
    );
    expect(res.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("rejects a per-hash pathname directly (no partial restore via individual hash blob)", async () => {
    // v2 individual hash blobs live under the per-day prefix but only the
    // manifest is an allowed entry point. Restoring a single hash blob
    // would skip the other 6 and leave Redis in a partial state.
    const res = await POST(
      req("address-labels-backup-2026-05-21/labels.json", {
        authorization: "Bearer secret",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("POST /api/address-labels/restore — v1 legacy monolithic blob", () => {
  it("restores a private Blob snapshot with preserved report metadata under cron auth", async () => {
    const snapshot = {
      exportedAt: "2026-05-11T00:00:00.000Z",
      addresses: {},
      reports: {
        ["0x" + "a".repeat(40)]: {
          body: "Investigation",
          authorEmail: "analyst@mentolabs.xyz",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-02T00:00:00.000Z",
          version: 3,
        },
      },
    };
    mockGet.mockResolvedValueOnce(
      blobResult(snapshot) as Awaited<ReturnType<typeof get>>,
    );

    const res = await POST(
      req("address-labels-backup-2026-05-11.json", {
        authorization: "Bearer secret",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith(
      "address-labels-backup-2026-05-11.json",
      expect.objectContaining({ access: "private", useCache: false }),
    );
    expect(mockHandleSnapshot).toHaveBeenCalledWith(
      snapshot,
      expect.objectContaining({
        importerEmail: "restore@cron",
        reportMetadataMode: "preserve",
        labelProvenanceMode: "preserve",
        writeMode: "replace",
        errorTag: "address-labels/restore",
      }),
    );
  });

  it("returns 404 when the Blob SDK cannot find the snapshot", async () => {
    mockGet.mockResolvedValueOnce(null);
    const res = await POST(
      req("address-labels-backup-2026-05-11.json", {
        authorization: "Bearer secret",
      }),
    );
    expect(res.status).toBe(404);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an oversized Blob without draining the stream when metadata size is unavailable", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // Legacy blobs use the higher 32 MB cap, so push something definitely
        // bigger than that.
        controller.enqueue(new Uint8Array(33 * 1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    mockGet.mockResolvedValueOnce(
      streamBlobResult(stream) as unknown as Awaited<ReturnType<typeof get>>,
    );
    const res = await POST(
      req("address-labels-backup-2026-05-11.json", {
        authorization: "Bearer secret",
      }),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON blobs", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult("{nope") as Awaited<ReturnType<typeof get>>,
    );
    const res = await POST(
      req("address-labels-backup-2026-05-11.json", {
        authorization: "Bearer secret",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects JSON that is not an address-label snapshot", async () => {
    mockIsSnapshot.mockReturnValueOnce(false);
    const res = await POST(
      req("address-labels-backup-2026-05-11.json", {
        authorization: "Bearer secret",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("returns a structured 500 when snapshot handling rejects", async () => {
    const err = new Error("Redis offline");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockHandleSnapshot.mockRejectedValueOnce(err);

    const res = await POST(
      req("address-labels-backup-2026-05-11.json", {
        authorization: "Bearer secret",
      }),
    );

    await expect(res.json()).resolves.toEqual({ error: "Restore failed" });
    expect(res.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledWith(err, {
      tags: { route: "address-labels/restore" },
    });
    consoleError.mockRestore();
  });
});

describe("POST /api/address-labels/restore — v2 manifest", () => {
  const date = "2026-05-21";
  const manifestPath = `address-labels-backup-${date}/manifest.json`;
  const manifest = {
    version: BACKUP_MANIFEST_VERSION,
    exportedAt: "2026-05-21T03:00:00.000Z",
    hashes: [
      {
        name: "labels",
        pathname: `address-labels-backup-${date}/labels.json`,
        sizeBytes: 100,
      },
      {
        name: "reports",
        pathname: `address-labels-backup-${date}/reports.json`,
        sizeBytes: 50,
      },
      {
        name: "intelDeep",
        pathname: `address-labels-backup-${date}/intelDeep.json`,
        sizeBytes: 20,
      },
      {
        name: "intelTransfers",
        pathname: `address-labels-backup-${date}/intelTransfers.json`,
        sizeBytes: 20,
      },
      {
        name: "intelWealth",
        pathname: `address-labels-backup-${date}/intelWealth.json`,
        sizeBytes: 20,
      },
      {
        name: "intelEntities",
        pathname: `address-labels-backup-${date}/intelEntities.json`,
        sizeBytes: 20,
      },
      {
        name: "intelEntityCps",
        pathname: `address-labels-backup-${date}/intelEntityCps.json`,
        sizeBytes: 20,
      },
    ],
  };
  const labelRecords = {
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
      name: "Test",
      tags: [],
      updatedAt: "2026-01-01T00:00:00Z",
    },
  };
  const reportRecords = {
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {
      body: "Report",
      authorEmail: "alice@mentolabs.xyz",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-30T00:00:00Z",
      version: 1,
    },
  };

  /**
   * Sequence the per-blob get() responses: manifest first, then each hash
   * blob in the order the manifest lists them. The route fetches hashes in
   * parallel via Promise.all, so we mock by call order — Promise.all
   * preserves resolution order for the array values, but the network calls
   * fan out concurrently.
   */
  function mockManifestSequence(): void {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(labelRecords) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(reportRecords) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 5; i++) {
      // intelDeep, intelTransfers, intelWealth, intelEntities, intelEntityCps
      // — empty maps are valid (the source hash had no records yet).
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }
  }

  function mockManifestSequenceWithHash(
    hashName: string,
    records: unknown,
  ): void {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    for (const entry of manifest.hashes) {
      const body =
        entry.name === hashName
          ? records
          : entry.name === "labels"
            ? labelRecords
            : entry.name === "reports"
              ? reportRecords
              : {};
      mockGet.mockResolvedValueOnce(
        blobResult(body) as Awaited<ReturnType<typeof get>>,
      );
    }
  }

  it("fetches manifest, fetches each hash blob, assembles the snapshot, then hands off to handleSnapshot", async () => {
    mockManifestSequence();
    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );
    expect(res.status).toBe(200);
    // manifest + 7 hash blobs = 8 get() calls
    expect(mockGet).toHaveBeenCalledTimes(8);
    expect(mockGet.mock.calls[0]?.[0]).toBe(manifestPath);

    // Assembled snapshot passed to handleSnapshot
    expect(mockHandleSnapshot).toHaveBeenCalledOnce();
    const [snapshotArg, options] = mockHandleSnapshot.mock.calls[0]!;
    expect(snapshotArg.exportedAt).toBe(manifest.exportedAt);
    expect(snapshotArg.addresses).toEqual(labelRecords);
    expect(snapshotArg.reports).toEqual(reportRecords);
    expect(snapshotArg.intelDeep).toEqual({});
    expect(options.writeMode).toBe("replace");
    expect(options.reportMetadataMode).toBe("preserve");
  });

  it("rejects a manifest blob with the wrong version field", async () => {
    const badManifest = { ...manifest, version: "v3-future" };
    mockGet.mockResolvedValueOnce(
      blobResult(badManifest) as Awaited<ReturnType<typeof get>>,
    );
    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );
    expect(res.status).toBe(400);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a manifest blob that is not JSON", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult("not-json") as Awaited<ReturnType<typeof get>>,
    );
    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );
    expect(res.status).toBe(400);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects when a referenced hash blob is missing", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    // First hash blob fetch returns null — Blob SDK miss
    mockGet.mockResolvedValueOnce(null);
    // Fill out the other 6 so Promise.all doesn't throw on unmet mocks
    for (let i = 0; i < 6; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }
    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );
    expect(res.status).toBe(404);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects when a hash blob contains invalid JSON", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult("{not-json") as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 6; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }
    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );
    expect(res.status).toBe(400);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed label hash records before replacing Redis data", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult({
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": null,
      }) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(reportRecords) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 5; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("invalid label payload"),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid label addresses and empty names before replacing Redis data", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult({
        "not-0x-address": { name: "", tags: [] },
      }) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(reportRecords) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 5; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("invalid label address"),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects empty legacy label names before replacing Redis data", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult({
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { label: "", tags: [] },
      }) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(reportRecords) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 5; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("invalid label payload"),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects labels with non-string tag values before replacing Redis data", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult({
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { tags: [42] },
      }) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(reportRecords) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 5; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("invalid label tags"),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed report hash records before replacing Redis data", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(labelRecords) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult({
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": { title: "No body" },
      }) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 5; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("invalid report payload"),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects report hash records with malformed preserved metadata before replacing Redis data", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(labelRecords) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult({
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {
          body: "Report",
          authorEmail: 42,
        },
      }) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 5; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("invalid authorEmail"),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an assembled manifest snapshot that fails snapshot validation before replacing Redis data", async () => {
    mockManifestSequence();
    mockIsSnapshot.mockReturnValueOnce(false);

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining(
        "Manifest snapshot is not an address-label snapshot",
      ),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed intel hash records before replacing Redis data", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(labelRecords) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult(reportRecords) as Awaited<ReturnType<typeof get>>,
    );
    mockGet.mockResolvedValueOnce(
      blobResult({ bad: [] }) as Awaited<ReturnType<typeof get>>,
    );
    for (let i = 0; i < 4; i++) {
      mockGet.mockResolvedValueOnce(
        blobResult({}) as Awaited<ReturnType<typeof get>>,
      );
    }

    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("invalid intelDeep payload"),
    });
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      "intelDeep",
      { "0xcccccccccccccccccccccccccccccccccccccccc": {} },
      "invalid intelDeep address",
    ],
    [
      "intelTransfers",
      { "0xcccccccccccccccccccccccccccccccccccccccc": {} },
      "invalid intelTransfers address",
    ],
    [
      "intelWealth",
      { "0xcccccccccccccccccccccccccccccccccccccccc": {} },
      "invalid intelWealth address",
    ],
    ["intelEntities", { "bad slug": {} }, "invalid intelEntities slug"],
    ["intelEntityCps", { "bad slug": {} }, "invalid intelEntityCps slug"],
  ])(
    "rejects object-shaped malformed %s records before replacing Redis data",
    async (hashName, records, expectedError) => {
      mockManifestSequenceWithHash(hashName, records);

      const res = await POST(
        req(manifestPath, { authorization: "Bearer secret" }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: expect.stringContaining(expectedError),
      });
      expect(mockHandleSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "intelDeep",
      {
        "0xcccccccccccccccccccccccccccccccccccccccc": {
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    [
      "intelTransfers",
      {
        "0xcccccccccccccccccccccccccccccccccccccccc": {
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    [
      "intelWealth",
      {
        "0xcccccccccccccccccccccccccccccccccccccccc": {
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    ["intelEntities", { "sample-entity": { slug: "sample-entity" } }],
    ["intelEntityCps", { "sample-entity": { slug: "sample-entity" } }],
  ])(
    "accepts legacy/minimal %s records for disaster restore compatibility",
    async (hashName, records) => {
      mockManifestSequenceWithHash(hashName, records);

      const res = await POST(
        req(manifestPath, { authorization: "Bearer secret" }),
      );

      expect(res.status).toBe(200);
      expect(mockHandleSnapshot).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "intelDeep",
      {
        "0xcccccccccccccccccccccccccccccccccccccccc": {
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          fetchedAt: "2026-05-21T03:00:00.000Z",
          candidate: {},
          enriched: null,
          counterparties: null,
          entity: null,
          contract: null,
          error: null,
          version: 1,
        },
      },
      "invalid intelDeep payload",
    ],
    [
      "intelTransfers",
      {
        "0xcccccccccccccccccccccccccccccccccccccccc": {
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          fetchedAt: "2026-05-21T03:00:00.000Z",
          transferCount: 1,
          transfers: [{}],
        },
      },
      "invalid intelTransfers payload",
    ],
    [
      "intelWealth",
      {
        "0xcccccccccccccccccccccccccccccccccccccccc": {
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          fetchedAt: "2026-05-21T03:00:00.000Z",
          sources: ["test"],
          balances: null,
          portfolio: { "0d_ago": {} },
          version: 1,
        },
      },
      "invalid intelWealth payload",
    ],
    [
      "intelEntities",
      {
        "sample-entity": {
          slug: "sample-entity",
          fetchedAt: "2026-05-21T03:00:00.000Z",
          name: "Sample",
          note: "",
          id: "sample-entity",
          customized: false,
          type: "organization",
          service: null,
          addresses: [],
          website: null,
          twitter: null,
          crunchbase: null,
          linkedin: null,
          populatedTags: [{}],
        },
      },
      "invalid intelEntities payload",
    ],
    [
      "intelEntityCps",
      {
        "sample-entity": {
          slug: "sample-entity",
          fetchedAt: "2026-05-21T03:00:00.000Z",
          counterparties: { "ethereum:out": [{}] },
        },
      },
      "invalid intelEntityCps payload",
    ],
  ])(
    "rejects nested malformed %s records before replacing Redis data",
    async (hashName, records, expectedError) => {
      mockManifestSequenceWithHash(hashName, records);

      const res = await POST(
        req(manifestPath, { authorization: "Bearer secret" }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: expect.stringContaining(expectedError),
      });
      expect(mockHandleSnapshot).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized manifest blob", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult(manifest, RESTORE_LIMIT + 1) as Awaited<
        ReturnType<typeof get>
      >,
    );
    const res = await POST(
      req(manifestPath, { authorization: "Bearer secret" }),
    );
    expect(res.status).toBe(413);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });
});
