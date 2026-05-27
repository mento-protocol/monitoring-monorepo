import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { requireCronAuth } from "@/lib/cron-auth";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function makeReq(authHeader?: string): NextRequest {
  return new NextRequest("http://localhost/route", {
    method: "GET",
    ...(authHeader ? { headers: { authorization: authHeader } } : {}),
  });
}

describe("requireCronAuth", () => {
  it("returns null in development without checking anything else", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await requireCronAuth(makeReq(), "test");
    expect(res).toBeNull();
  });

  it("500s when CRON_SECRET is unset in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "");
    const res = await requireCronAuth(makeReq("Bearer anything"), "test");
    expect(res?.status).toBe(500);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/CRON_SECRET/);
  });

  it("returns null on Bearer match", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "secret");
    const res = await requireCronAuth(makeReq("Bearer secret"), "test");
    expect(res).toBeNull();
  });

  it("401s when bearer doesn't match — no session fallback", async () => {
    // CSRF defence: a logged-in user navigating cross-site to the GET cron
    // path would otherwise sign-in with their cookie and trigger Redis writes
    // / blob uploads. Bearer-only.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "secret");
    const res = await requireCronAuth(makeReq("Bearer wrong"), "test");
    expect(res?.status).toBe(401);
  });

  it("401s when no Authorization header is present", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "secret");
    const res = await requireCronAuth(makeReq(), "test");
    expect(res?.status).toBe(401);
  });
});
