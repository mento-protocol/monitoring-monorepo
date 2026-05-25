import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/intel-transfers", () => ({ getIntelTransfers: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { getAuthSession } from "@/auth";
import { getIntelTransfers } from "@/lib/intel-transfers";
import { GET } from "../route";

const ADDR = "0x" + "b".repeat(40);
const mockSession = vi.mocked(getAuthSession);
const mockGet = vi.mocked(getIntelTransfers);

function makeReq(address = ADDR) {
  return new NextRequest(`http://localhost/api/intel/transfers/${address}`);
}
function params(address = ADDR) {
  return { params: Promise.resolve({ address }) };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/intel/transfers/[address]", () => {
  it("401 when unauthenticated", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(makeReq(), params());
    expect(res.status).toBe(401);
  });

  it("400 for invalid address", async () => {
    mockSession.mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      expires: "",
    });
    const res = await GET(makeReq("not-an-address"), params("not-an-address"));
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

  it("200 with the record on hit", async () => {
    mockSession.mockResolvedValue({
      user: { email: "test@mentolabs.xyz" },
      expires: "",
    });
    const record = {
      address: ADDR,
      fetchedAt: "2026-01-01",
      transferCount: 5,
      transfers: null,
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

  it("500 when auth session lookup throws", async () => {
    mockSession.mockRejectedValue(new Error("auth down"));
    const res = await GET(makeReq(), params());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to read intel transfers record",
    });
  });
});
