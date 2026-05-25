import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-reports", async () => {
  // Pull through the real shared schema/sanitize so we exercise the same
  // validation logic the route uses in production. Only the data-access
  // layer (Redis-backed) is mocked.
  const shared = await vi.importActual<
    typeof import("@/lib/address-reports-shared")
  >("@/lib/address-reports-shared");
  return {
    AddressReportVersionConflictError: class AddressReportVersionConflictError extends Error {
      readonly existingVersion: number | null;

      constructor(existingVersion: number | null) {
        super("Address report version conflict");
        this.name = "AddressReportVersionConflictError";
        this.existingVersion = existingVersion;
      }
    },
    findReport: vi.fn(),
    getReportsIndex: vi.fn().mockResolvedValue({ addresses: [] }),
    upsertReport: vi.fn(),
    deleteReport: vi.fn().mockResolvedValue(undefined),
    sanitizeReportInput: shared.sanitizeReportInput,
    MAX_BODY_LENGTH: shared.MAX_BODY_LENGTH,
  };
});

import { getAuthSession } from "@/auth";
import {
  AddressReportVersionConflictError,
  findReport,
  getReportsIndex,
  upsertReport,
  deleteReport,
} from "@/lib/address-reports";
import { MAX_BODY_LENGTH } from "@/lib/address-reports-shared";

beforeEach(() => {
  vi.clearAllMocks();
});

const VALID_ADDR = "0xb64c8b0a3f8008d5028d8f9323b858f17b18c3c4";

const SESSION = {
  user: { email: "alice@mentolabs.xyz" },
} as const;

describe("GET /api/address-reports", () => {
  it("returns 401 when unauthenticated (index)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/address-reports"),
    );
    expect(res.status).toBe(401);
    expect(getReportsIndex).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (single)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(
      new NextRequest(
        `http://localhost/api/address-reports?address=${VALID_ADDR}`,
      ),
    );
    expect(res.status).toBe(401);
    expect(findReport).not.toHaveBeenCalled();
  });

  it("returns the addresses-only index when authenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (getReportsIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      addresses: [VALID_ADDR, "0xaaaa"],
    });
    const res = await GET(
      new NextRequest("http://localhost/api/address-reports"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { addresses: string[] };
    expect(body.addresses).toEqual([VALID_ADDR, "0xaaaa"]);
  });

  it("returns 404 when single report not found", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (findReport as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(
      new NextRequest(
        `http://localhost/api/address-reports?address=${VALID_ADDR}`,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns the report when found", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (findReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: "# hello",
      title: "T",
      version: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    });
    const res = await GET(
      new NextRequest(
        `http://localhost/api/address-reports?address=${VALID_ADDR}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string; version: number };
    expect(body.body).toBe("# hello");
    expect(body.version).toBe(3);
  });

  it("returns 400 on an invalid address query param", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await GET(
      new NextRequest("http://localhost/api/address-reports?address=not-hex"),
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/address-reports", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({ address: VALID_ADDR, body: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid address", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({ address: "not-hex", body: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a null JSON body", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify(null),
      }),
    );
    expect(res.status).toBe(400);
    expect(upsertReport).not.toHaveBeenCalled();
  });

  it("rejects an array JSON body", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify([{ address: VALID_ADDR, body: "x" }]),
      }),
    );
    expect(res.status).toBe(400);
    expect(upsertReport).not.toHaveBeenCalled();
  });

  it("rejects a body that exceeds the size cap", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const tooBig = "a".repeat(MAX_BODY_LENGTH + 1);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({ address: VALID_ADDR, body: tooBig }),
      }),
    );
    expect(res.status).toBe(400);
    expect(upsertReport).not.toHaveBeenCalled();
  });

  it("server-sets authorEmail from session (never trusts request body)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (upsertReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: "x",
      version: 1,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
      authorEmail: "alice@mentolabs.xyz",
    });

    await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({
          address: VALID_ADDR,
          body: "x",
          // attempt to spoof the author — must be ignored
          authorEmail: "attacker@evil.example",
        }),
      }),
    );

    expect(upsertReport).toHaveBeenCalledOnce();
    const args = (upsertReport as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // upsertReport(address, payload) — payload is the second arg.
    expect(args[1]).toMatchObject({ authorEmail: "alice@mentolabs.xyz" });
  });

  it("allows create semantics without a base version", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (upsertReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: "x",
      version: 1,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    });

    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({ address: VALID_ADDR, body: "x" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upsertReport).toHaveBeenCalledWith(
      VALID_ADDR,
      expect.not.objectContaining({ baseVersion: expect.anything() }),
    );
  });

  it("passes a client-supplied baseVersion precondition to storage", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (upsertReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: "x",
      version: 4,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    });

    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({
          address: VALID_ADDR,
          body: "x",
          baseVersion: 3,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upsertReport).toHaveBeenCalledWith(
      VALID_ADDR,
      expect.objectContaining({ baseVersion: 3 }),
    );
  });

  it("accepts an If-Match version precondition", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (upsertReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: "x",
      version: 4,
      createdAt: "2026-05-07T00:00:00Z",
      updatedAt: "2026-05-07T00:00:00Z",
    });

    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        headers: { "If-Match": '"3"' },
        body: JSON.stringify({ address: VALID_ADDR, body: "x" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upsertReport).toHaveBeenCalledWith(
      VALID_ADDR,
      expect.objectContaining({ baseVersion: 3 }),
    );
  });

  it("returns 400 for an invalid baseVersion", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);

    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({
          address: VALID_ADDR,
          body: "x",
          baseVersion: 0,
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(upsertReport).not.toHaveBeenCalled();
  });

  it("returns 409 when storage detects a stale base version", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (upsertReport as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AddressReportVersionConflictError(7),
    );

    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({
          address: VALID_ADDR,
          body: "x",
          baseVersion: 6,
        }),
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Report version conflict",
      existingVersion: 7,
    });
  });
});

describe("DELETE /api/address-reports", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify({ address: VALID_ADDR }),
      }),
    );
    expect(res.status).toBe(401);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  it("requires a version precondition", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify({ address: VALID_ADDR }),
      }),
    );
    expect(res.status).toBe(400);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  it("deletes with an If-Match version precondition", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        headers: { "If-Match": '"3"' },
        body: JSON.stringify({ address: VALID_ADDR }),
      }),
    );
    expect(res.status).toBe(200);
    expect(deleteReport).toHaveBeenCalledWith(VALID_ADDR, 3);
  });

  it("deletes with a body baseVersion precondition", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify({ address: VALID_ADDR, baseVersion: 4 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(deleteReport).toHaveBeenCalledWith(VALID_ADDR, 4);
  });

  it("returns 409 when storage detects a stale delete", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (deleteReport as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AddressReportVersionConflictError(7),
    );

    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        headers: { "If-Match": '"6"' },
        body: JSON.stringify({ address: VALID_ADDR }),
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Report version conflict",
      existingVersion: 7,
    });
  });

  it("rejects an invalid address", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify({ address: "not-hex" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  it("rejects a null JSON body", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify(null),
      }),
    );
    expect(res.status).toBe(400);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  it("rejects an array JSON body", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify([{ address: VALID_ADDR }]),
      }),
    );
    expect(res.status).toBe(400);
    expect(deleteReport).not.toHaveBeenCalled();
  });
});

describe("body-size guard", () => {
  it("PUT returns 413 when content-length exceeds the cap", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        // 1 MiB content-length forces the early-exit before req.json runs.
        headers: { "content-length": String(1024 * 1024) },
        body: JSON.stringify({
          address: VALID_ADDR,
          body: "x",
        }),
      }),
    );
    expect(res.status).toBe(413);
    expect(upsertReport).not.toHaveBeenCalled();
  });

  it("PUT enforces byte cap even without content-length header", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    // Construct a body that's over the 256KB PUT cap. Drop the
    // content-length header to simulate a chunked request.
    const oversizedBody = "a".repeat(300 * 1024);
    const req = new NextRequest("http://localhost/api/address-reports", {
      method: "PUT",
      body: JSON.stringify({ address: VALID_ADDR, body: oversizedBody }),
    });
    // Force absent content-length to simulate chunked transfer.
    req.headers.delete("content-length");
    const res = await PUT(req);
    expect(res.status).toBe(413);
    expect(upsertReport).not.toHaveBeenCalled();
  });

  it("PUT 500s when upsertReport throws", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (upsertReport as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("redis down"),
    );
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({ address: VALID_ADDR, body: "report body" }),
      }),
    );
    expect(res.status).toBe(500);
  });
});
