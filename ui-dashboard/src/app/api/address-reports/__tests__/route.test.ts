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
    findReport: vi.fn(),
    getReportSummaries: vi.fn().mockResolvedValue({ global: [], chains: {} }),
    upsertReport: vi.fn(),
    deleteReport: vi.fn().mockResolvedValue(undefined),
    sanitizeReportInput: shared.sanitizeReportInput,
    MAX_BODY_LENGTH: shared.MAX_BODY_LENGTH,
  };
});

import { getAuthSession } from "@/auth";
import {
  findReport,
  getReportSummaries,
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
    expect(getReportSummaries).not.toHaveBeenCalled();
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

  it("returns the lightweight index when authenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (getReportSummaries as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: [
        {
          address: VALID_ADDR,
          scope: "global",
          updatedAt: "2026-05-07T00:00:00Z",
          version: 2,
          bodyLength: 1234,
        },
      ],
      chains: {},
    });
    const res = await GET(
      new NextRequest("http://localhost/api/address-reports"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      global: { address: string; bodyLength: number }[];
    };
    expect(body.global[0]?.address).toBe(VALID_ADDR);
    expect(body.global[0]?.bodyLength).toBe(1234);
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

  it("returns the report with its scope when found", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    (findReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      scope: 42220,
      report: {
        body: "# hello",
        title: "T",
        version: 3,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-05-07T00:00:00Z",
      },
    });
    const res = await GET(
      new NextRequest(
        `http://localhost/api/address-reports?address=${VALID_ADDR}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: number; body: string };
    expect(body.scope).toBe(42220);
    expect(body.body).toBe("# hello");
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
        body: JSON.stringify({
          scope: "global",
          address: VALID_ADDR,
          body: "x",
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unsupported chainId scope", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({
          scope: 999_999,
          address: VALID_ADDR,
          body: "x",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body that exceeds the size cap", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const tooBig = "a".repeat(MAX_BODY_LENGTH + 1);
    const res = await PUT(
      new NextRequest("http://localhost/api/address-reports", {
        method: "PUT",
        body: JSON.stringify({
          scope: "global",
          address: VALID_ADDR,
          body: tooBig,
        }),
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
          scope: "global",
          address: VALID_ADDR,
          body: "x",
          // attempt to spoof the author — must be ignored
          authorEmail: "attacker@evil.example",
        }),
      }),
    );

    expect(upsertReport).toHaveBeenCalledOnce();
    const args = (upsertReport as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[2]).toMatchObject({ authorEmail: "alice@mentolabs.xyz" });
  });
});

describe("DELETE /api/address-reports", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify({ scope: "global", address: VALID_ADDR }),
      }),
    );
    expect(res.status).toBe(401);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  it("deletes when authenticated with valid scope", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION);
    const res = await DELETE(
      new NextRequest("http://localhost/api/address-reports", {
        method: "DELETE",
        body: JSON.stringify({ scope: "global", address: VALID_ADDR }),
      }),
    );
    expect(res.status).toBe(200);
    expect(deleteReport).toHaveBeenCalledWith("global", VALID_ADDR);
  });
});
