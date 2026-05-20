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

vi.mock("@/lib/address-labels/snapshot", () => ({
  isSnapshot: vi.fn(() => true),
  handleSnapshot: vi.fn(async () =>
    Response.json({ ok: true, imported: { addresses: 1 } }),
  ),
}));

import { getAuthSession } from "@/auth";
import * as Sentry from "@sentry/nextjs";
import { get } from "@vercel/blob";
import { handleSnapshot, isSnapshot } from "@/lib/address-labels/snapshot";
import { MAX_REDIS_HASH_REPLACE_BYTES } from "@/lib/redis-hash";
import { POST } from "../route";

const mockGetAuthSession = vi.mocked(getAuthSession);
const mockGet = vi.mocked(get);
const mockCaptureException = vi.mocked(Sentry.captureException);
const mockHandleSnapshot = vi.mocked(handleSnapshot);
const mockIsSnapshot = vi.mocked(isSnapshot);
const RESTORE_LIMIT = MAX_REDIS_HASH_REPLACE_BYTES;

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

describe("POST /api/address-labels/restore", () => {
  it("requires bearer or workspace-session auth", async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

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

  it("rejects an oversized Blob before reading the stream", async () => {
    mockGet.mockResolvedValueOnce(
      blobResult({ addresses: {} }, RESTORE_LIMIT + 1) as Awaited<
        ReturnType<typeof get>
      >,
    );
    const res = await POST(
      req("address-labels-backup-2026-05-11.json", {
        authorization: "Bearer secret",
      }),
    );
    expect(res.status).toBe(413);
    expect(mockHandleSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an oversized Blob without draining the stream when metadata size is unavailable", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(RESTORE_LIMIT + 1));
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
