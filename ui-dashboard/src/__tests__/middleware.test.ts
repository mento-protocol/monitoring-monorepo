import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// The middleware exports `auth(callback)` — NextAuth invokes the callback
// with a request that has `.auth` set. We capture the callback and test it
// directly, bypassing NextAuth's own session resolution.
type AuthReq = NextRequest & { auth: { user: { email: string } } | null };
type MiddlewareCallback = (req: AuthReq) => Response | undefined;

let middlewareCallback: MiddlewareCallback;

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  auth: vi.fn((cb: MiddlewareCallback) => {
    middlewareCallback = cb;
    return cb;
  }),
}));

// Auth env vars must be set before module load so authConfigured = true
vi.stubEnv("AUTH_GOOGLE_ID", "test-id");
vi.stubEnv("AUTH_GOOGLE_SECRET", "test-secret");

// Import after mocks and env are set up
await import("@/middleware");

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(
  path: string,
  opts: { method?: string; authenticated?: boolean; email?: string } = {},
): AuthReq {
  const { method = "GET", authenticated = false, email } = opts;
  const url = new URL(path, "http://localhost");
  const resolvedEmail = email ?? (authenticated ? "alice@mentolabs.xyz" : null);
  return {
    auth: resolvedEmail ? { user: { email: resolvedEmail } } : null,
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

  it("returns 401 for unauthenticated GET /api/address-labels", () => {
    // GET is no longer public — the unauth public-label path was retired in
    // the CSP PR, so middleware now gates every method.
    const res = middlewareCallback(makeReq("/api/address-labels"));
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
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

  it("returns 401 for a session with a non-mentolabs email on PUT", () => {
    // Defense-in-depth: the sign-in callback rejects non-Workspace users, but
    // a forged JWT (e.g. AUTH_SECRET leaked) carrying an attacker-controlled
    // email must still be blocked at the edge.
    const res = middlewareCallback(
      makeReq("/api/address-labels", {
        method: "PUT",
        email: "attacker@gmail.com",
      }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("redirects a session with a non-mentolabs email on /address-book", () => {
    const res = middlewareCallback(
      makeReq("/address-book", { email: "attacker@gmail.com" }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(302);
    expect(res!.headers.get("location") ?? "").toContain("/sign-in");
  });

  it("rejects a lookalike suffix like @mentolabs.xyz.evil.com", () => {
    // `endsWith("@mentolabs.xyz")` would accept anything whose string ends in
    // the literal domain. The email local-part contains the `@`, so a crafted
    // address like `foo@mentolabs.xyz.evil.com` can't end with `@mentolabs.xyz`
    // — but pin the behavior so nobody loosens the check to `.endsWith("mentolabs.xyz")`.
    const res = middlewareCallback(
      makeReq("/api/address-labels", {
        method: "PUT",
        email: "foo@mentolabs.xyz.evil.com",
      }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });
});
