import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { Account, Profile, NextAuthConfig } from "next-auth";

// Capture the NextAuth config when the module is loaded
let capturedConfig: NextAuthConfig;
// Capture options passed to Google() factory so we can assert provider checks
let capturedGoogleOptions: Record<string, unknown> = {};

vi.mock("next-auth", () => {
  const NextAuth = vi.fn((config: NextAuthConfig) => {
    capturedConfig = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  });
  return { default: NextAuth };
});

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
  await loadAuthWithEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    email?: string;
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
      credentials: undefined,
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
  it("uses a 1-hour JWT maxAge to bound stale-session risk", async () => {
    await loadAuthWithEnv();
    expect(capturedConfig.session?.strategy).toBe("jwt");
    expect(capturedConfig.session?.maxAge).toBe(60 * 60);
    expect(capturedConfig.session?.updateAge).toBe(10 * 60);
  });
});
