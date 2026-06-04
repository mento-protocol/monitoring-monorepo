import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { Account, Profile, NextAuthConfig, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

// Capture the NextAuth config when the module is loaded
let capturedConfig: NextAuthConfig;
// Capture options passed to Google() factory so we can assert provider checks
let capturedGoogleOptions: Record<string, unknown> = {};
// Session returned by the mocked `auth()` — set per-test to exercise getAuthSession.
let mockSession: Session | null = null;

vi.mock("next-auth", () => {
  const NextAuth = vi.fn((config: NextAuthConfig) => {
    capturedConfig = config;
    return {
      handlers: {},
      auth: vi.fn(async () => mockSession),
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  });
  return { default: NextAuth };
});

// Minimal Response-like object so the fetch stub doesn't depend on a global
// Response implementation across runtimes.
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

type JwtParams = Parameters<
  NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>
>[0];

function callJwt(args: {
  token: JWT;
  account?: Partial<Account> | null;
  profile?: Partial<Profile>;
}) {
  return capturedConfig.callbacks?.jwt?.(args as unknown as JwtParams);
}

const nowSec = () => Math.floor(Date.now() / 1000);

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((opts: Record<string, unknown> = {}) => {
    capturedGoogleOptions = opts;
    return { id: "google" };
  }),
}));

async function loadAuthWithEnv(redirectProxyUrl?: string) {
  vi.resetModules();
  capturedConfig = {} as NextAuthConfig;
  capturedGoogleOptions = {};

  if (redirectProxyUrl === undefined) {
    vi.unstubAllEnvs();
    delete process.env.AUTH_REDIRECT_PROXY_URL;
  } else {
    vi.stubEnv("AUTH_REDIRECT_PROXY_URL", redirectProxyUrl);
  }

  await import("@/auth");
}

beforeEach(async () => {
  mockSession = null;
  await loadAuthWithEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("auth config", () => {
  it("sets redirectProxyUrl when AUTH_REDIRECT_PROXY_URL is configured", async () => {
    await loadAuthWithEnv("https://monitoring.mento.org/api/auth");
    expect(capturedConfig.redirectProxyUrl).toBe(
      "https://monitoring.mento.org/api/auth",
    );
  });

  it("leaves redirectProxyUrl undefined when AUTH_REDIRECT_PROXY_URL is unset", async () => {
    await loadAuthWithEnv(undefined);
    expect(capturedConfig.redirectProxyUrl).toBeUndefined();
  });
});

describe("Google provider checks config", () => {
  it("uses state-only checks on preview (VERCEL_ENV=preview)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    await loadAuthWithEnv("https://monitoring.mento.org/api/auth");
    expect(capturedGoogleOptions.checks).toEqual(["state"]);
  });

  it("uses default checks on production even with AUTH_REDIRECT_PROXY_URL set", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    await loadAuthWithEnv("https://monitoring.mento.org/api/auth");
    // No checks override — PKCE is left to Auth.js defaults on prod
    expect(capturedGoogleOptions.checks).toBeUndefined();
  });

  it("uses default checks when VERCEL_ENV is unset", async () => {
    await loadAuthWithEnv(undefined);
    expect(capturedGoogleOptions.checks).toBeUndefined();
  });
});

describe("auth signIn callback", () => {
  type ProfileOverrides = {
    email?: string | undefined;
    hd?: string | undefined;
    email_verified?: boolean | undefined;
  };

  // Default profile shape = a valid Mento Workspace login. Tests opt in to
  // the failure cases by passing a subset override (e.g., `{ hd: undefined }`).
  function callSignIn(overrides: ProfileOverrides = {}) {
    const account = { provider: "google" } as Account;
    const defaults = {
      email: "alice@mentolabs.xyz",
      hd: "mentolabs.xyz",
      email_verified: true,
    };
    const profile = { ...defaults, ...overrides } as unknown as Profile;
    return capturedConfig.callbacks?.signIn?.({
      account,
      profile,
      user: {},
    });
  }

  it("accepts a valid Mento Workspace login (hd + verified + domain)", () => {
    expect(callSignIn()).toBe(true);
  });

  it("rejects other email domains", () => {
    expect(callSignIn({ email: "alice@gmail.com", hd: undefined })).toBe(false);
  });

  it("accepts mixed-case @mentolabs.xyz emails", () => {
    expect(callSignIn({ email: "Alice@MentoLabs.xyz" })).toBe(true);
  });

  it("rejects missing email", () => {
    expect(callSignIn({ email: undefined })).toBe(false);
  });

  it("rejects when hd claim is missing (e.g., personal Gmail)", () => {
    // Personal Google accounts have no `hd` claim. Even if the display email
    // ends in @mentolabs.xyz (it can't, but belt-and-braces), the absence of
    // `hd: mentolabs.xyz` proves the account is not on our Workspace tenant.
    expect(callSignIn({ hd: undefined })).toBe(false);
  });

  it("rejects when hd claim points to a different Workspace", () => {
    // A Workspace that happens to have mentolabs.xyz as a secondary alias
    // would carry its own `hd`, not ours.
    expect(callSignIn({ hd: "other-workspace.com" })).toBe(false);
  });

  it("rejects when email_verified is false", () => {
    expect(callSignIn({ email_verified: false })).toBe(false);
  });

  it("rejects when email_verified is missing", () => {
    expect(callSignIn({ email_verified: undefined })).toBe(false);
  });
});

describe("session config", () => {
  it("uses a sliding 30-day JWT session so deploys/active use don't force re-login", async () => {
    await loadAuthWithEnv();
    expect(capturedConfig.session?.strategy).toBe("jwt");
    expect(capturedConfig.session?.maxAge).toBe(30 * 24 * 60 * 60);
    expect(capturedConfig.session?.updateAge).toBe(24 * 60 * 60);
  });
});

describe("Google provider offline access", () => {
  it("requests a refresh token (access_type=offline, prompt=consent)", () => {
    expect(capturedGoogleOptions.authorization).toEqual({
      params: { access_type: "offline", prompt: "consent" },
    });
  });
});

describe("jwt callback — Google re-validation", () => {
  it("on sign-in, stores the refresh token + expiry and clears any prior error", async () => {
    const token = (await callJwt({
      token: { error: "RefreshTokenError" },
      account: { provider: "google", refresh_token: "rt_1", expires_at: 9999 },
      profile: { email: "alice@mentolabs.xyz" },
    })) as JWT;
    expect(token.email).toBe("alice@mentolabs.xyz");
    expect(token.refresh_token).toBe("rt_1");
    expect(token.expires_at).toBe(9999);
    expect(token.error).toBeUndefined();
  });

  it("on sign-in with no refresh token, marks the session errored", async () => {
    const token = (await callJwt({
      token: {},
      account: { provider: "google" },
      profile: { email: "alice@mentolabs.xyz" },
    })) as JWT;
    expect(token.error).toBe("RefreshTokenError");
  });

  it("passes the token through untouched while the access token is fresh", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const expires_at = nowSec() + 3600;
    const token = (await callJwt({
      token: { refresh_token: "rt_1", expires_at },
    })) as JWT;
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(token.expires_at).toBe(expires_at);
    expect(token.error).toBeUndefined();
  });

  it("marks a legacy token (no probe data) errored to force one re-auth", async () => {
    const token = (await callJwt({
      token: { email: "alice@mentolabs.xyz" },
    })) as JWT;
    expect(token.error).toBe("RefreshTokenError");
  });

  it("refreshes a still-live account when the access token has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(200, { access_token: "at_new", expires_in: 3600 }),
      ),
    );
    const token = (await callJwt({
      token: { refresh_token: "rt_1", expires_at: nowSec() - 10 },
    })) as JWT;
    expect(token.error).toBeUndefined();
    expect(token.refresh_token).toBe("rt_1");
    expect(token.expires_at).toBeGreaterThan(nowSec());
  });

  it("cuts off a revoked account (invalid_grant): errored + refresh token dropped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(400, { error: "invalid_grant" })),
    );
    const token = (await callJwt({
      token: { refresh_token: "rt_1", expires_at: nowSec() - 10 },
    })) as JWT;
    expect(token.error).toBe("RefreshTokenError");
    expect(token.refresh_token).toBeUndefined();
  });

  it("keeps the session on a transient Google failure (5xx) and retries soon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(503, "unavailable")),
    );
    const token = (await callJwt({
      token: { refresh_token: "rt_1", expires_at: nowSec() - 10 },
    })) as JWT;
    expect(token.error).toBeUndefined();
    expect(token.refresh_token).toBe("rt_1");
    expect(token.expires_at).toBeGreaterThan(nowSec());
    expect(token.expires_at).toBeLessThanOrEqual(nowSec() + 5 * 60 + 2);
  });

  it("does NOT evict on our own misconfig (invalid_client) — only invalid_grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(401, { error: "invalid_client" })),
    );
    const token = (await callJwt({
      token: { refresh_token: "rt_1", expires_at: nowSec() - 10 },
    })) as JWT;
    expect(token.error).toBeUndefined();
    expect(token.refresh_token).toBe("rt_1");
  });
});

describe("session callback", () => {
  function callSession(token: JWT) {
    return capturedConfig.callbacks?.session?.({
      session: { user: { email: "alice@mentolabs.xyz" } },
      token,
    } as unknown as Parameters<
      NonNullable<NonNullable<NextAuthConfig["callbacks"]>["session"]>
    >[0]);
  }

  it("surfaces a RefreshTokenError onto the session", async () => {
    const session = (await callSession({
      email: "alice@mentolabs.xyz",
      error: "RefreshTokenError",
    })) as Session;
    expect(session.error).toBe("RefreshTokenError");
  });

  it("leaves error unset for a healthy token", async () => {
    const session = (await callSession({
      email: "alice@mentolabs.xyz",
    })) as Session;
    expect(session.error).toBeUndefined();
  });
});

describe("getAuthSession", () => {
  it("returns null when the session carries a RefreshTokenError", async () => {
    mockSession = {
      user: { email: "alice@mentolabs.xyz" },
      error: "RefreshTokenError",
    } as unknown as Session;
    const { getAuthSession } = await import("@/auth");
    expect(await getAuthSession()).toBeNull();
  });

  it("returns the session for a healthy @mentolabs.xyz user", async () => {
    mockSession = {
      user: { email: "alice@mentolabs.xyz" },
    } as unknown as Session;
    const { getAuthSession } = await import("@/auth");
    expect(await getAuthSession()).toBe(mockSession);
  });

  it("returns null for a non-allowed domain", async () => {
    mockSession = {
      user: { email: "mallory@gmail.com" },
    } as unknown as Session;
    const { getAuthSession } = await import("@/auth");
    expect(await getAuthSession()).toBeNull();
  });
});
