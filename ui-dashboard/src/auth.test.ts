import { describe, it, expect, vi, beforeAll } from "vitest";
import type { Account, Profile, NextAuthConfig } from "next-auth";

// Capture the NextAuth config when the module is loaded
let capturedConfig: NextAuthConfig;

vi.mock("next-auth", () => {
  const NextAuth = vi.fn((config: NextAuthConfig) => {
    capturedConfig = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  });
  return { default: NextAuth };
});

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn(() => ({ id: "google" })),
}));

beforeAll(async () => {
  await import("@/auth");
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

  it("rejects missing email", () => {
    expect(callSignIn(undefined)).toBe(false);
  });
});
