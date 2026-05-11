import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
}));

vi.mock("@/lib/address-labels/snapshot", () => ({
  isSnapshot: vi.fn(() => true),
  handleSnapshot: vi.fn(async () =>
    Response.json({ ok: true, imported: { addresses: 1 } }),
  ),
}));

import { getAuthSession } from "@/auth";
import { get } from "@vercel/blob";
import { handleSnapshot, isSnapshot } from "@/lib/address-labels/snapshot";
import { POST } from "../route";

const mockGetAuthSession = vi.mocked(getAuthSession);
const mockGet = vi.mocked(get);
const mockHandleSnapshot = vi.mocked(handleSnapshot);
const mockIsSnapshot = vi.mocked(isSnapshot);

function req(
  pathname = "address-labels-backup-2026-05-11.json",
  headers?: HeadersInit,
): NextRequest {
  const url = new URL("http://localhost/api/address-labels/restore");
  if (pathname) url.searchParams.set("pathname", pathname);
  return new NextRequest(url, { method: "POST", headers });
}

function blobResult(body: unknown, size?: number) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    statusCode: 200,
    stream: new Response(text).body,
    blob: {
      size: size ?? Buffer.byteLength(text, "utf8"),
    },
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
      blobResult({ addresses: {} }, 32 * 1024 * 1024 + 1) as Awaited<
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
});
