import crypto from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyQuickNodeHmac } from "./quicknode-hmac";

const sign = (secret: string, nonce: string, ts: string, payload: string) =>
  crypto
    .createHmac("sha256", secret)
    .update(nonce + ts + payload)
    .digest("hex");

describe("verifyQuickNodeHmac", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts a correctly signed payload", () => {
    const sig = sign("secret", "nonce", "1700000000", "{}");
    expect(
      verifyQuickNodeHmac("secret", "{}", "nonce", "1700000000", sig),
    ).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const sig = sign("other", "nonce", "1700000000", "{}");
    expect(
      verifyQuickNodeHmac("secret", "{}", "nonce", "1700000000", sig),
    ).toBe(false);
  });

  it("cleanly rejects non-hex and odd-length signatures", () => {
    expect(
      verifyQuickNodeHmac(
        "secret",
        "{}",
        "nonce",
        "1700000000",
        "zz".repeat(32),
      ),
    ).toBe(false);
    expect(
      verifyQuickNodeHmac("secret", "{}", "nonce", "1700000000", "abc"),
    ).toBe(false);
  });

  it("prints debug output when DEBUG is set", () => {
    vi.stubEnv("DEBUG", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sig = sign("secret", "nonce", "1700000000", "{}");
    expect(
      verifyQuickNodeHmac("secret", "{}", "nonce", "1700000000", sig),
    ).toBe(true);
    expect(logSpy).toHaveBeenCalled();
  });
});
