import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", () => ({
  importLabels: vi.fn().mockResolvedValue(undefined),
}));

import { getAuthSession } from "@/auth";
import { importLabels } from "@/lib/address-labels";

function jsonReq(body: unknown) {
  return new NextRequest("http://localhost/api/address-labels/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: "alice@mentolabs.xyz" },
  });
});

describe("POST /api/address-labels/import", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(jsonReq({ chainId: 42220, labels: {} }));
    expect(res.status).toBe(401);
  });

  it("imports simple format with valid chainId", async () => {
    const labels = {
      "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
    };
    const res = await POST(jsonReq({ chainId: 42220, labels }));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledWith(42220, labels);
  });

  it("imports snapshot format", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        "42220": {
          "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
        },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(200);
    expect(importLabels).toHaveBeenCalledTimes(1);
  });

  it("rejects snapshot with invalid chainId keys", async () => {
    const snapshot = {
      exportedAt: "2026-01-01T00:00:00Z",
      chains: {
        foo: { "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" } },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("foo");
    expect(importLabels).not.toHaveBeenCalled();
  });

  it("rejects snapshot with negative chainId keys", async () => {
    const snapshot = {
      chains: {
        "-1": {
          "0xabc": { label: "Test", updatedAt: "2026-01-01T00:00:00Z" },
        },
      },
    };
    const res = await POST(jsonReq(snapshot));
    expect(res.status).toBe(400);
  });

  it("rejects simple format with invalid chainId", async () => {
    const res = await POST(jsonReq({ chainId: -5, labels: {} }));
    expect(res.status).toBe(400);
  });

  it("rejects simple format with invalid labels shape", async () => {
    const res = await POST(jsonReq({ chainId: 42220, labels: "not-object" }));
    expect(res.status).toBe(400);
  });

  it("rejects labels where entries lack a label field", async () => {
    const res = await POST(
      jsonReq({
        chainId: 42220,
        labels: { "0xabc": { notes: "no label field" } },
      }),
    );
    expect(res.status).toBe(400);
  });
});
