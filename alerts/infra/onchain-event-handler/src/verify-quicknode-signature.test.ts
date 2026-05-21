/**
 * Unit tests for QuickNode signature verification
 */

import crypto from "crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { verifyQuickNodeSignature } from "./verify-quicknode-signature";

describe("verifyQuickNodeSignature", () => {
  const secret = "test-secret-key";
  const payload = '{"test": "data"}';
  const nonce = "12345";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should verify valid signature", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Create a valid signature using crypto
    const signatureData = nonce + timestamp + payload;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(signatureData);
    const validSignature = hmac.digest("hex");

    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      timestamp,
      validSignature,
    );

    expect(result).toBe(true);
  });

  it("should reject invalid signature", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const invalidSignature = "invalid-signature";

    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      timestamp,
      invalidSignature,
    );

    expect(result).toBe(false);
  });

  it("should reject signature with missing parameters", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    expect(verifyQuickNodeSignature("", payload, nonce, timestamp, "sig")).toBe(
      false,
    );
    expect(verifyQuickNodeSignature(secret, "", nonce, timestamp, "sig")).toBe(
      false,
    );
    expect(
      verifyQuickNodeSignature(secret, payload, "", timestamp, "sig"),
    ).toBe(false);
    expect(verifyQuickNodeSignature(secret, payload, nonce, "", "sig")).toBe(
      false,
    );
    expect(
      verifyQuickNodeSignature(secret, payload, nonce, timestamp, ""),
    ).toBe(false);
  });

  it("should reject timestamp outside acceptable window", () => {
    // Use timestamp 10 minutes in the past
    const oldTimestamp = Math.floor(
      (Date.now() - 10 * 60 * 1000) / 1000,
    ).toString();
    const signatureData = nonce + oldTimestamp + payload;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(signatureData);
    const signature = hmac.digest("hex");

    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      oldTimestamp,
      signature,
    );

    expect(result).toBe(false);
  });

  it("should accept timestamp within acceptable window", () => {
    // Use timestamp 2 minutes in the past (within 5 minute window)
    vi.setSystemTime(Date.now() - 2 * 60 * 1000);
    const recentTimestamp = Math.floor(Date.now() / 1000).toString();
    const signatureData = nonce + recentTimestamp + payload;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(signatureData);
    const signature = hmac.digest("hex");

    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      recentTimestamp,
      signature,
    );

    expect(result).toBe(true);
  });

  it("should reject invalid timestamp format", () => {
    const signatureData = nonce + "invalid-timestamp" + payload;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(signatureData);
    const signature = hmac.digest("hex");

    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      "invalid-timestamp",
      signature,
    );

    expect(result).toBe(false);
  });
});
