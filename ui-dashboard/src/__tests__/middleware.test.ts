import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// The middleware exports `auth(callback)` — NextAuth invokes the callback
// with a request that has `.auth` set. We capture the callback and test it
// directly, bypassing NextAuth's own session resolution.
type AuthReq = NextRequest & { auth: { user: { email: string } } | null };
type MiddlewareCallback = (req: AuthReq) => Response | undefined;

let middlewareCallback: MiddlewareCallback;

vi.mock("@/auth", () => ({
  auth: vi.fn((cb: MiddlewareCallback) => {
    middlewareCallback = cb;
    return cb;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Import after mocks are set up
await import("@/middleware");

function makeReq(
  path: string,
  opts: { method?: string; authenticated?: boolean } = {},
): AuthReq {
  const { method = "GET", authenticated = false } = opts;
  const url = new URL(path, "http://localhost");
  return {
    auth: authenticated ? { user: { email: "alice@mentolabs.xyz" } } : null,
    method,
    nextUrl: url,
  } as unknown as AuthReq;
}

describe("middleware", () => {
  it("redirects unauthenticated /address-book to /sign-in", () => {
    const res = middlewareCallback(makeReq("/address-book"));
    expect(res).toBeDefined();
    expect(res!.status).toBe(302);
    const location = res!.headers.get("location") ?? "";
    expect(location).toContain("/sign-in");
    expect(location).toContain("callbackUrl=%2Faddress-book");
  });

  it("redirects unauthenticated /address-book/sub-path to /sign-in", () => {
    const res = middlewareCallback(makeReq("/address-book/some/page"));
    expect(res).toBeDefined();
    expect(res!.status).toBe(302);
  });

  it("preserves query params in callbackUrl on redirect", () => {
    const res = middlewareCallback(
      makeReq("/address-book?filter=custom&sort=name"),
    );
    expect(res).toBeDefined();
    const location = res!.headers.get("location") ?? "";
    expect(location).toContain(
      encodeURIComponent("/address-book?filter=custom&sort=name"),
    );
  });

  it("allows authenticated /address-book through", () => {
    const res = middlewareCallback(
      makeReq("/address-book", { authenticated: true }),
    );
    expect(res).toBeUndefined();
  });

  it("returns 401 for unauthenticated PUT /api/address-labels", () => {
    const res = middlewareCallback(
      makeReq("/api/address-labels", { method: "PUT" }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("returns 401 for unauthenticated DELETE /api/address-labels", () => {
    const res = middlewareCallback(
      makeReq("/api/address-labels", { method: "DELETE" }),
    );
    expect(res!.status).toBe(401);
  });

  it("allows unauthenticated GET /api/address-labels through", () => {
    const res = middlewareCallback(makeReq("/api/address-labels"));
    expect(res).toBeUndefined();
  });

  it("returns 401 for unauthenticated /api/address-labels/export", () => {
    const res = middlewareCallback(makeReq("/api/address-labels/export"));
    expect(res!.status).toBe(401);
  });

  it("allows unauthenticated /api/address-labels/backup through", () => {
    const res = middlewareCallback(
      makeReq("/api/address-labels/backup", { method: "POST" }),
    );
    expect(res).toBeUndefined();
  });

  it("allows authenticated PUT /api/address-labels through", () => {
    const res = middlewareCallback(
      makeReq("/api/address-labels", { method: "PUT", authenticated: true }),
    );
    expect(res).toBeUndefined();
  });
});
