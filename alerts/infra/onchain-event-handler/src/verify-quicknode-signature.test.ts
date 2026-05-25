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

  // ---------- Boundary + drift coverage ----------

  // MAX_TIMESTAMP_DIFF_MS = 5 * 60 * 1000 = 300_000 ms (5 minutes).
  // Implementation rejects when `Math.abs(now - timestampMs) > MAX`.
  // Timestamps are second-precision; we pin `now` to an offset within a
  // second so we can hit MAX-1 and MAX+1 boundaries exactly.

  function signTimestamp(ts: string): string {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(nonce + ts + payload);
    return hmac.digest("hex");
  }

  it("accepts timestamp exactly at MAX_TIMESTAMP_DIFF_MS - 1 in the past", () => {
    // Anchor "now" at a known ms with a 999ms sub-second component so we can
    // get diff = 299_999 (MAX_DIFF_MS - 1) using a second-precision timestamp.
    const anchorSec = 1_700_000_000; // arbitrary epoch-like value
    const now = anchorSec * 1000 + 999;
    vi.setSystemTime(now);

    // timestamp = anchorSec - 299 (seconds in past). diff = 999 + 299_000 = 299_999 ms = MAX - 1
    const ts = (anchorSec - 299).toString();
    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      ts,
      signTimestamp(ts),
    );
    expect(result).toBe(true);
  });

  it("rejects timestamp exactly at MAX_TIMESTAMP_DIFF_MS + 1 in the past", () => {
    const anchorSec = 1_700_000_000;
    const now = anchorSec * 1000 + 1; // 1ms after the second boundary
    vi.setSystemTime(now);

    // timestamp = anchorSec - 300 (300s back). diff = 1 + 300_000 = 300_001 ms = MAX + 1 → reject
    const ts = (anchorSec - 300).toString();
    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      ts,
      signTimestamp(ts),
    );
    expect(result).toBe(false);
  });

  it("accepts timestamp 1 second in the FUTURE (drift in either direction)", () => {
    const anchorSec = 1_700_000_000;
    vi.setSystemTime(anchorSec * 1000);

    const ts = (anchorSec + 1).toString();
    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      ts,
      signTimestamp(ts),
    );
    expect(result).toBe(true);
  });

  it("rejects timestamp MAX_TIMESTAMP_DIFF_MS + 1 ms in the FUTURE", () => {
    const anchorSec = 1_700_000_000;
    // now = anchorSec*1000 - 1ms. ts (in future) = anchorSec + 300s.
    // diff = (anchorSec + 300)*1000 - (anchorSec*1000 - 1) = 300_001 ms > MAX → reject.
    const now = anchorSec * 1000 - 1;
    vi.setSystemTime(now);

    const ts = (anchorSec + 300).toString();
    const result = verifyQuickNodeSignature(
      secret,
      payload,
      nonce,
      ts,
      signTimestamp(ts),
    );
    expect(result).toBe(false);
  });

  it("replay: same timestamp+nonce+signature can be verified twice (known limitation: no nonce store)", () => {
    // The current implementation does NOT track previously-seen nonces, so a
    // captured (timestamp, nonce, signature) tuple is replayable within the
    // 5-minute window. This test pins that as KNOWN behavior — if a nonce
    // store is added, this test should be updated to expect the second call
    // to return false.
    const anchorSec = 1_700_000_000;
    vi.setSystemTime(anchorSec * 1000);

    const ts = anchorSec.toString();
    const sig = signTimestamp(ts);

    const first = verifyQuickNodeSignature(secret, payload, nonce, ts, sig);
    const second = verifyQuickNodeSignature(secret, payload, nonce, ts, sig);

    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  // ---------- Hex-validation negative tests ----------

  it("rejects odd-length signature string", () => {
    const anchorSec = 1_700_000_000;
    vi.setSystemTime(anchorSec * 1000);
    const ts = anchorSec.toString();

    // 63 hex chars (odd length, isValidHex requires even)
    const oddLenSig = "a".repeat(63);
    expect(
      verifyQuickNodeSignature(secret, payload, nonce, ts, oddLenSig),
    ).toBe(false);
  });

  it("rejects signature with non-hex characters", () => {
    const anchorSec = 1_700_000_000;
    vi.setSystemTime(anchorSec * 1000);
    const ts = anchorSec.toString();

    // 64 chars, even-length, but contains 'z' and 'g' — not valid hex
    const nonHexSig = "z".repeat(64);
    expect(
      verifyQuickNodeSignature(secret, payload, nonce, ts, nonHexSig),
    ).toBe(false);

    const mixedSig = "g" + "a".repeat(63);
    expect(verifyQuickNodeSignature(secret, payload, nonce, ts, mixedSig)).toBe(
      false,
    );
  });

  it("rejects empty signature string", () => {
    const anchorSec = 1_700_000_000;
    vi.setSystemTime(anchorSec * 1000);
    const ts = anchorSec.toString();

    // Empty signature → falsy check at the top of verifyQuickNodeSignature
    // returns false before we even reach hex validation.
    expect(verifyQuickNodeSignature(secret, payload, nonce, ts, "")).toBe(
      false,
    );
  });
});
