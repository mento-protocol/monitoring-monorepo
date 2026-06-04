import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  auth: vi.fn().mockResolvedValue({
    user: { email: "test@mentolabs.xyz" },
  }),
}));

vi.mock("@/lib/address-labels", () => ({
  getLabels: vi.fn(),
}));

vi.mock("@/lib/address-reports", () => ({
  getAllReports: vi.fn().mockResolvedValue({}),
}));

import { auth } from "@/auth";
import { getLabels } from "@/lib/address-labels";
import { getAllReports } from "@/lib/address-reports";

beforeEach(() => {
  vi.clearAllMocks();
  (auth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: "test@mentolabs.xyz" },
  });
  (getAllReports as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

describe("GET /api/address-labels/export", () => {
  it("returns 401 when unauthenticated", async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
    expect(getLabels).not.toHaveBeenCalled();
  });

  it("returns 401 when the session carries a RefreshTokenError (revoked account)", async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      error: "RefreshTokenError",
    });
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
    expect(getLabels).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated outside the maintainer Workspace", async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "intruder@example.com" },
    });

    const res = await GET();

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
    expect(getLabels).not.toHaveBeenCalled();
    expect(getAllReports).not.toHaveBeenCalled();
  });

  it("allows an authenticated maintainer Workspace session", async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "Test@MentoLabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await GET();

    expect(res.status).toBe(200);
    expect(getLabels).toHaveBeenCalledOnce();
  });

  it("exports a single flat snapshot under the `addresses` key", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      "0xabc": { name: "Test", tags: [], updatedAt: "2026-01-01T00:00:00Z" },
      "0xggg": {
        name: "Other",
        tags: ["whale"],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      addresses: Record<string, { name: string }>;
      exportedAt: string;
      global?: unknown;
      chains?: unknown;
    };
    expect(body.exportedAt).toBeDefined();
    expect(body.addresses["0xabc"]!.name).toBe("Test");
    expect(body.addresses["0xggg"]!.name).toBe("Other");
    // Legacy global/chains keys must NOT appear in new snapshots.
    expect(body.global).toBeUndefined();
    expect(body.chains).toBeUndefined();
  });

  it("includes forensic reports under `reports` (parity with daily backup)", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (getAllReports as ReturnType<typeof vi.fn>).mockResolvedValue({
      "0xabc": {
        body: "Investigation",
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-30T00:00:00Z",
        version: 1,
      },
    });

    const res = await GET();
    const body = (await res.json()) as {
      reports?: Record<string, { body: string; version: number }>;
    };
    expect(body.reports).toBeDefined();
    expect(body.reports?.["0xabc"]!.body).toBe("Investigation");
    expect(body.reports?.["0xabc"]!.version).toBe(1);
  });

  it("ignores any chainId/scope query params (back-compat)", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const res = await GET();
    expect(res.status).toBe(200);
    expect(getLabels).toHaveBeenCalledWith();
  });

  it("attaches a Content-Disposition with a date-stamped filename", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const res = await GET();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(/address-labels-\d{4}-\d{2}-\d{2}\.json/);
  });

  it("returns 500 when getLabels throws", async () => {
    (getLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Redis connection failed"),
    );
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Export failed");
  });
});
