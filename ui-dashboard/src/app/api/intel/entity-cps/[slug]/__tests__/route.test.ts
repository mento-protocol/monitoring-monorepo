import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/intel-entity-cps", () => ({ getIntelEntityCps: vi.fn() }));
vi.mock("@/lib/intel-entities", () => ({
  INTEL_ENTITY_SLUG_RE: /^[a-z0-9_.-]{1,128}$/,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { getAuthSession } from "@/auth";
import { getIntelEntityCps } from "@/lib/intel-entity-cps";
import { GET } from "../route";

const mockSession = vi.mocked(getAuthSession);
const mockGet = vi.mocked(getIntelEntityCps);

function makeReq(slug = "coinbase") {
  return new NextRequest(`http://localhost/api/intel/entity-cps/${slug}`);
}
function params(slug = "coinbase") {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/intel/entity-cps/[slug]", () => {
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
    const res = await GET(makeReq("BAD SLUG!"), params("BAD SLUG!"));
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

  it("200 with entity-cps record on hit", async () => {
    mockSession.mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      expires: "",
    });
    const record = {
      slug: "coinbase",
      fetchedAt: "2026-01-01",
      counterparties: null,
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
