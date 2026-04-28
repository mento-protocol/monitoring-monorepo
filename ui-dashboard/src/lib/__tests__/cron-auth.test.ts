import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  getAuthSession: vi.fn(),
}));

import { requireCronOrSession } from "@/lib/cron-auth";
import { getAuthSession } from "@/auth";

const mockGetAuthSession = vi.mocked(getAuthSession);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function makeReq(authHeader?: string): NextRequest {
  return new NextRequest("http://localhost/route", {
    method: "POST",
    headers: authHeader ? { authorization: authHeader } : undefined,
  });
}

describe("requireCronOrSession", () => {
  it("returns null in development without checking anything else", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await requireCronOrSession(makeReq(), "test");
    expect(res).toBeNull();
    expect(mockGetAuthSession).not.toHaveBeenCalled();
  });

  it("500s when CRON_SECRET is unset in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "");
    const res = await requireCronOrSession(makeReq("Bearer anything"), "test");
    expect(res?.status).toBe(500);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/CRON_SECRET/);
  });

  it("returns null on Bearer match", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "secret");
    const res = await requireCronOrSession(makeReq("Bearer secret"), "test");
    expect(res).toBeNull();
    // Bearer match short-circuits the session check.
    expect(mockGetAuthSession).not.toHaveBeenCalled();
  });

  it("falls back to session when Bearer doesn't match", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "secret");
    mockGetAuthSession.mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
      expires: "2099-01-01T00:00:00Z",
    });
    const res = await requireCronOrSession(makeReq("Bearer wrong"), "test");
    expect(res).toBeNull();
  });

  it("falls back to session when no Authorization header is present", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "secret");
    mockGetAuthSession.mockResolvedValue({
      user: { email: "alice@mentolabs.xyz" },
      expires: "2099-01-01T00:00:00Z",
    });
    const res = await requireCronOrSession(makeReq(), "test");
    expect(res).toBeNull();
  });

  it("401s when neither Bearer nor session validates", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "secret");
    mockGetAuthSession.mockResolvedValue(null);
    const res = await requireCronOrSession(makeReq("Bearer wrong"), "test");
    expect(res?.status).toBe(401);
  });
});
