import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "../route";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/address-labels", async () => {
  const shared = await vi.importActual<
    typeof import("@/lib/address-labels-shared")
  >("@/lib/address-labels-shared");
  return {
    ...shared,
    getLabels: vi.fn().mockResolvedValue({}),
    getLabel: vi.fn().mockResolvedValue(null),
    upsertEntry: vi.fn().mockResolvedValue(undefined),
    deleteLabel: vi.fn().mockResolvedValue(undefined),
  };
});

import { getAuthSession } from "@/auth";
import {
  deleteLabel,
  getLabel,
  getLabels,
  upsertEntry,
} from "@/lib/address-labels";

const VALID_ADDR = "0x" + "a".repeat(40);

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — wipes implementations so a per-test
  // override (e.g. `mockResolvedValue({...prior})`) doesn't bleed into the
  // next test.
  vi.resetAllMocks();
  (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (getLabel as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (upsertEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (deleteLabel as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe("GET /api/address-labels", () => {
  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getLabels).not.toHaveBeenCalled();
  });

  it("returns the flat labels map when authenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
      [VALID_ADDR]: { name: "Alice", tags: [], updatedAt: "2026-01-01" },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(getLabels).toHaveBeenCalledOnce();
    const body = (await res.json()) as Record<string, { name: string }>;
    expect(body[VALID_ADDR].name).toBe("Alice");
  });

  it("ignores any chainId/scope query params (back-compat: flat map only)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const res = await GET();
    expect(res.status).toBe(200);
    // Single-arg call — chainId/scope aren't forwarded.
    expect(getLabels).toHaveBeenCalledWith();
  });

  it("returns 500 when getLabels throws", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
    (getLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Redis offline"),
    );
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/address-labels", () => {
  beforeEach(() => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
  });

  function jsonReq(body: Record<string, unknown>): NextRequest {
    return new NextRequest("http://localhost/api/address-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PUT(jsonReq({ address: VALID_ADDR, name: "Alice" }));
    expect(res.status).toBe(401);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("rejects an invalid address", async () => {
    const res = await PUT(jsonReq({ address: "not-an-address", name: "X" }));
    expect(res.status).toBe(400);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("rejects a payload with neither name nor tags", async () => {
    const res = await PUT(jsonReq({ address: VALID_ADDR, name: "", tags: [] }));
    expect(res.status).toBe(400);
  });

  it("accepts a tag-only payload (empty name, non-empty tags)", async () => {
    const res = await PUT(
      jsonReq({ address: VALID_ADDR, name: "", tags: ["whale"] }),
    );
    expect(res.status).toBe(200);
    const [addr, entry] = (upsertEntry as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(addr).toBe(VALID_ADDR);
    expect(entry).toMatchObject({ name: "", tags: ["whale"] });
  });

  it("calls upsertEntry with single-arg signature (address, entry)", async () => {
    const res = await PUT(
      jsonReq({ address: VALID_ADDR, name: "Alice", tags: [] }),
    );
    expect(res.status).toBe(200);
    const calls = (upsertEntry as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2); // (address, entry) — no scope arg
    expect(calls[0][0]).toBe(VALID_ADDR);
  });

  it("rejects name longer than 200 chars", async () => {
    const longName = "a".repeat(201);
    const res = await PUT(jsonReq({ address: VALID_ADDR, name: longName }));
    expect(res.status).toBe(400);
  });

  it("rejects notes longer than 500 chars", async () => {
    const res = await PUT(
      jsonReq({
        address: VALID_ADDR,
        name: "Alice",
        notes: "x".repeat(501),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects more than 20 tags", async () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const res = await PUT(
      jsonReq({ address: VALID_ADDR, name: "Alice", tags }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects tags longer than 50 chars", async () => {
    const res = await PUT(
      jsonReq({
        address: VALID_ADDR,
        name: "Alice",
        tags: ["a".repeat(51)],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("strips reserved server-provenance tags (arkham, minipay) from user input", async () => {
    const res = await PUT(
      jsonReq({
        address: VALID_ADDR,
        name: "Alice",
        tags: ["arkham", "minipay", "whale"],
      }),
    );
    expect(res.status).toBe(200);
    const [, entry] = (upsertEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry.tags).toEqual(["whale"]);
  });

  it("dedupes tags case-insensitively, preserving first-occurrence casing", async () => {
    const res = await PUT(
      jsonReq({
        address: VALID_ADDR,
        name: "Alice",
        tags: ["Whale", "whale", "WHALE"],
      }),
    );
    expect(res.status).toBe(200);
    const [, entry] = (upsertEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry.tags).toEqual(["Whale"]);
  });

  it("preserves Arkham source on edit (does not demote to custom)", async () => {
    (getLabel as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "Old",
      tags: [],
      source: "arkham",
      updatedAt: "2025-01-01T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const res = await PUT(
      jsonReq({ address: VALID_ADDR, name: "User edit", tags: ["whale"] }),
    );
    expect(res.status).toBe(200);
    const [, entry] = (upsertEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry.source).toBe("arkham");
    expect(entry.createdAt).toBe("2025-01-01T00:00:00Z");
  });

  it("preserves MiniPay source on edit", async () => {
    (getLabel as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "MiniPay user",
      tags: [],
      source: "minipay",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const res = await PUT(jsonReq({ address: VALID_ADDR, name: "Edited" }));
    expect(res.status).toBe(200);
    const [, entry] = (upsertEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry.source).toBe("minipay");
  });
});

describe("DELETE /api/address-labels", () => {
  beforeEach(() => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
    });
  });

  function jsonReq(body: Record<string, unknown>): NextRequest {
    return new NextRequest("http://localhost/api/address-labels", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(jsonReq({ address: VALID_ADDR }));
    expect(res.status).toBe(401);
    expect(deleteLabel).not.toHaveBeenCalled();
  });

  it("rejects an invalid address", async () => {
    const res = await DELETE(jsonReq({ address: "not-an-address" }));
    expect(res.status).toBe(400);
    expect(deleteLabel).not.toHaveBeenCalled();
  });

  it("calls deleteLabel with single-arg signature (address only)", async () => {
    const res = await DELETE(jsonReq({ address: VALID_ADDR }));
    expect(res.status).toBe(200);
    const calls = (deleteLabel as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1); // (address) — no scope arg
    expect(calls[0][0]).toBe(VALID_ADDR);
  });
});
