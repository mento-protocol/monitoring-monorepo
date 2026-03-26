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
  function callSignIn(email: string | undefined) {
    const account = { provider: "google" } as Account;
    const profile = email ? ({ email } as Profile) : ({} as Profile);
    return capturedConfig.callbacks?.signIn?.({
      account,
      profile,
      user: {},
      credentials: undefined,
    });
  }

  it("accepts @mentolabs.xyz accounts", () => {
    expect(callSignIn("alice@mentolabs.xyz")).toBe(true);
  });

  it("rejects other domains", () => {
    expect(callSignIn("alice@gmail.com")).toBe(false);
  });

  it("accepts mixed-case @mentolabs.xyz emails", () => {
    expect(callSignIn("Alice@MentoLabs.xyz")).toBe(true);
  });

  it("rejects missing email", () => {
    expect(callSignIn(undefined)).toBe(false);
  });
});
