import { afterEach, describe, it, expect, vi } from "vitest";
import { buildCspWithNonce } from "@/lib/csp";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("buildCspWithNonce", () => {
  it("includes the nonce in script-src", () => {
    const csp = buildCspWithNonce("abc123==");
    expect(csp).toContain("'nonce-abc123=='");
    expect(csp).toContain("script-src");
  });

  it("does not include unsafe-inline in script-src", () => {
    const csp = buildCspWithNonce("test");
    const scriptSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("retains unsafe-inline in style-src (required for React inline styles)", () => {
    const csp = buildCspWithNonce("test");
    const styleSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("style-src"));
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("preserves the full connect-src allowlist", () => {
    const csp = buildCspWithNonce("test");
    const connectSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("connect-src"));
    expect(connectSrc).toBeDefined();
    expect(connectSrc).toContain("https://indexer.hyperindex.xyz");
    expect(connectSrc).toContain("https://forno.celo.org");
    expect(connectSrc).toContain("https://rpc2.monad.xyz");
    expect(connectSrc).toContain("https://testnet-rpc.monad.xyz");
    expect(connectSrc).toContain("wss://ws-us3.pusher.com");
  });

  it("includes the configured testnet Hasura origin in connect-src", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_HASURA_URL_TESTNET",
      "https://testnet-hasura.example/v1/graphql",
    );
    vi.resetModules();

    const { buildCspWithNonce: buildCspWithEnv } = await import("@/lib/csp");
    const csp = buildCspWithEnv("test");
    const connectSrc = csp
      .split(";")
      .find((d) => d.trim().startsWith("connect-src"));

    expect(connectSrc).toBeDefined();
    expect(connectSrc).toContain("https://testnet-hasura.example");
  });

  it("includes frame-ancestors none (clickjacking defense)", () => {
    const csp = buildCspWithNonce("test");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("produces different nonce values for different inputs", () => {
    const csp1 = buildCspWithNonce("nonce1");
    const csp2 = buildCspWithNonce("nonce2");
    expect(csp1).not.toBe(csp2);
  });
});
