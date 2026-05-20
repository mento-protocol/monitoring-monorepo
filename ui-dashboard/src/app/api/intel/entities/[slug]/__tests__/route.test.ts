import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/intel-entities", () => ({
  getIntelEntity: vi.fn(),
  INTEL_ENTITY_SLUG_RE: /^[a-z0-9_-]{1,128}$/,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { getAuthSession } from "@/auth";
import { getIntelEntity } from "@/lib/intel-entities";
import { GET } from "../route";

const mockSession = vi.mocked(getAuthSession);
const mockGet = vi.mocked(getIntelEntity);

function makeReq(slug = "binance") {
  return new NextRequest(`http://localhost/api/intel/entities/${slug}`);
}
function params(slug = "binance") {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/intel/entities/[slug]", () => {
  it("401 when unauthenticated", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(makeReq(), params());
    expect(res.status).toBe(401);
  });

  it("400 for invalid slug", async () => {
    mockSession.mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      expires: "",
    });
    const res = await GET(makeReq("Invalid Slug!"), params("Invalid Slug!"));
    expect(res.status).toBe(400);
  });

  it("404 when lib returns null", async () => {
    mockSession.mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      expires: "",
    });
    mockGet.mockResolvedValue(null);
    const res = await GET(makeReq(), params());
    expect(res.status).toBe(404);
  });

  it("200 with entity record on hit", async () => {
    mockSession.mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      expires: "",
    });
    const record = {
      slug: "binance",
      fetchedAt: "2026-01-01",
      name: "Binance",
    };
    mockGet.mockResolvedValue(record as never);
    const res = await GET(makeReq(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(record);
  });

  it("500 when lib throws", async () => {
    mockSession.mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      expires: "",
    });
    mockGet.mockRejectedValue(new Error("redis down"));
    const res = await GET(makeReq(), params());
    expect(res.status).toBe(500);
  });
});
