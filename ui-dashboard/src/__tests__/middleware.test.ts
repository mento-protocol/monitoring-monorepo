import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// The middleware does `export default auth(callback)`.
// We mock `auth` to capture that inner callback so we can test the auth
// routing logic directly, without running NextAuth's own session resolution.
type AuthReq = NextRequest & {
  auth: { user: { email: string }; error?: "RefreshTokenError" } | null;
};
type MiddlewareCallback = (req: AuthReq) => Response | undefined;

let authCallback: MiddlewareCallback | undefined;

vi.mock("@/auth", () => ({
  ALLOWED_DOMAIN: "@mentolabs.xyz",
  auth: vi.fn((cb: MiddlewareCallback) => {
    authCallback = cb;
    // Return an async function that mimics what NextAuth v5 `auth(callback)`
    // returns: calls the callback with the request (req.auth attached).
    return async (req: AuthReq) => cb(req);
  }),
}));

vi.mock("@/lib/csp", () => ({
  buildCspWithNonce: vi.fn(() => "default-src 'self'"),
}));

async function importMiddlewareWithEnv(
  env: {
    authGoogleId?: string | undefined;
    authGoogleSecret?: string | undefined;
  } = {
    authGoogleId: "test-id",
    authGoogleSecret: "test-secret",
  },
): Promise<MiddlewareCallback> {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  authCallback = undefined;

  if (env.authGoogleId !== undefined) {
    vi.stubEnv("AUTH_GOOGLE_ID", env.authGoogleId);
  }
  if (env.authGoogleSecret !== undefined) {
    vi.stubEnv("AUTH_GOOGLE_SECRET", env.authGoogleSecret);
  }

  // Import after mocks and env are set up because authConfigured is evaluated
  // at module load.
  await import("@/middleware");
  const callback = authCallback as unknown;
  if (typeof callback !== "function") {
    throw new Error("middleware did not register auth callback");
  }
  return callback as MiddlewareCallback;
}

beforeEach(async () => {
  authCallback = await importMiddlewareWithEnv();
});

function makeReq(
  path: string,
  opts: {
    method?: string;
    authenticated?: boolean;
    email?: string;
    error?: "RefreshTokenError";
  } = {},
): AuthReq {
  const { method = "GET", authenticated = false, email, error } = opts;
  const url = new URL(path, "http://localhost");
  const resolvedEmail = email ?? (authenticated ? "alice@mentolabs.xyz" : null);
  return {
    auth: resolvedEmail ? { user: { email: resolvedEmail }, error } : null,
    method,
    nextUrl: url,
  } as unknown as AuthReq;
}

// Auth routing tests exercise the inner callback captured from auth(callback).
// This isolates the access-control logic from NextAuth session resolution.
//
// Note: the callback now ALWAYS returns a Response (either an auth denial or
// a NextResponse.next() with CSP headers). "Allow through" cases return a
// 200 NextResponse, not undefined, because the callback now owns CSP injection.
describe("middleware auth routing", () => {
  it("redirects unauthenticated /address-book to /sign-in", () => {
    const res = authCallback!(makeReq("/address-book"));
    expect(res).toBeDefined();
    // NextResponse.redirect(url, 302) — must be explicit since default is 307
    expect(res!.status).toBe(302);
    const location = res!.headers.get("location") ?? "";
    expect(location).toContain("/sign-in");
    expect(location).toContain("callbackUrl=%2Faddress-book");
  });

  it("redirects unauthenticated /address-book/sub-path to /sign-in", () => {
    const res = authCallback!(makeReq("/address-book/some/page"));
    expect(res).toBeDefined();
    expect(res!.status).toBe(302);
  });

  it("preserves query params in callbackUrl on redirect", () => {
    const res = authCallback!(makeReq("/address-book?filter=custom&sort=name"));
    expect(res).toBeDefined();
    const location = res!.headers.get("location") ?? "";
    expect(location).toContain(
      encodeURIComponent("/address-book?filter=custom&sort=name"),
    );
  });

  it("allows authenticated /address-book through (returns 200 with CSP)", () => {
    const res = authCallback!(
      makeReq("/address-book", { authenticated: true }),
    );
    // Callback returns NextResponse.next() with CSP, never undefined
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-security-policy")).toBeDefined();
  });

  it("returns 401 for unauthenticated PUT /api/address-labels", () => {
    const res = authCallback!(
      makeReq("/api/address-labels", { method: "PUT" }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("returns 401 for unauthenticated DELETE /api/address-labels", () => {
    const res = authCallback!(
      makeReq("/api/address-labels", { method: "DELETE" }),
    );
    expect(res!.status).toBe(401);
  });

  it("returns 401 for unauthenticated GET /api/address-labels", () => {
    // GET is no longer public — the unauth public-label path was retired in
    // the CSP PR, so middleware now gates every method.
    const res = authCallback!(makeReq("/api/address-labels"));
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("returns 401 for unauthenticated /api/address-labels/export", () => {
    const res = authCallback!(makeReq("/api/address-labels/export"));
    expect(res!.status).toBe(401);
  });

  it("allows unauthenticated /api/address-labels/backup through (returns 200 with CSP)", () => {
    const res = authCallback!(
      makeReq("/api/address-labels/backup", { method: "POST" }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
  });

  it("allows unauthenticated /api/address-labels/restore through to route auth (returns 200 with CSP)", () => {
    const res = authCallback!(
      makeReq("/api/address-labels/restore", { method: "POST" }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
  });

  it("allows authenticated PUT /api/address-labels through (returns 200 with CSP)", () => {
    const res = authCallback!(
      makeReq("/api/address-labels", { method: "PUT", authenticated: true }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
  });

  it("returns 401 for a session with a non-mentolabs email on PUT", () => {
    // Defense-in-depth: the sign-in callback rejects non-Workspace users, but
    // a forged JWT (e.g. AUTH_SECRET leaked) carrying an attacker-controlled
    // email must still be blocked at the edge.
    const res = authCallback!(
      makeReq("/api/address-labels", {
        method: "PUT",
        email: "attacker@gmail.com",
      }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("redirects a session with a non-mentolabs email on /address-book", () => {
    const res = authCallback!(
      makeReq("/address-book", { email: "attacker@gmail.com" }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(302);
    expect(res!.headers.get("location") ?? "").toContain("/sign-in");
  });

  it("redirects an errored (revoked refresh token) session on /address-book", () => {
    // The Google refresh probe failed with invalid_grant (offboarded account).
    // Even though the JWT carries a valid @mentolabs.xyz email, the edge must
    // treat the session as unauthenticated — matches getAuthSession().
    const res = authCallback!(
      makeReq("/address-book", {
        authenticated: true,
        error: "RefreshTokenError",
      }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(302);
    expect(res!.headers.get("location") ?? "").toContain("/sign-in");
  });

  it("returns 401 for an errored (revoked refresh token) session on PUT /api/address-labels", () => {
    const res = authCallback!(
      makeReq("/api/address-labels", {
        method: "PUT",
        authenticated: true,
        error: "RefreshTokenError",
      }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("rejects a lookalike suffix like @mentolabs.xyz.evil.com", () => {
    // `endsWith("@mentolabs.xyz")` would accept anything whose string ends in
    // the literal domain. The email local-part contains the `@`, so a crafted
    // address like `foo@mentolabs.xyz.evil.com` can't end with `@mentolabs.xyz`
    // — but pin the behavior so nobody loosens the check to `.endsWith("mentolabs.xyz")`.
    const res = authCallback!(
      makeReq("/api/address-labels", {
        method: "PUT",
        email: "foo@mentolabs.xyz.evil.com",
      }),
    );
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("fails closed for protected pages when OAuth env vars are missing at module load", async () => {
    const callback = await importMiddlewareWithEnv({
      authGoogleId: undefined,
      authGoogleSecret: "test-secret",
    });

    const res = callback(makeReq("/address-book"));

    expect(res).toBeDefined();
    expect(res!.status).toBe(503);
    expect(res!.headers.get("x-middleware-next")).not.toBe("1");
  });

  it("fails closed for protected APIs when OAuth env vars are missing at module load", async () => {
    const callback = await importMiddlewareWithEnv({
      authGoogleId: "test-id",
      authGoogleSecret: undefined,
    });

    const res = callback(makeReq("/api/address-labels", { method: "PUT" }));

    expect(res).toBeDefined();
    expect(res!.status).toBe(503);
    expect(res!.headers.get("x-middleware-next")).not.toBe("1");
  });
});
