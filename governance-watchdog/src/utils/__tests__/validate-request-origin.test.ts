import type { Request } from "@google-cloud/functions-framework";
import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock getSecret so no Secret Manager calls happen and we can assert call counts
const mockGetSecret = vi.fn();
vi.mock("../get-secret.js", () => ({
  default: mockGetSecret,
}));

// Mock config to avoid env-schema validation during tests
vi.mock("../../config.js", () => ({
  default: {
    QUICKNODE_SECURITY_TOKEN_SECRET_ID: "quicknode-security-token",
    X_AUTH_TOKEN_SECRET_ID: "x-auth-token",
  },
}));

const SECURITY_TOKEN = "test-security-token";
const PAYLOAD = JSON.stringify({ result: [] });

/** Sign a payload the way QuickNode does: HMAC-SHA256 over nonce+timestamp+payload */
function sign(nonce: string, timestamp: string, payload: string): string {
  return crypto
    .createHmac("sha256", SECURITY_TOKEN)
    .update(nonce + timestamp + payload)
    .digest("hex");
}

/** Build a Request-like object carrying QuickNode headers and a raw body */
function makeQuicknodeRequest(headers: Record<string, string>): Request {
  return {
    headers,
    rawBody: Buffer.from(PAYLOAD),
  } as unknown as Request;
}

/** A fresh unix-seconds timestamp string */
function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("isFromQuicknode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetSecret.mockResolvedValue(SECURITY_TOKEN);
  });

  it("accepts a correctly signed request with a fresh timestamp", async () => {
    const { isFromQuicknode } = await import("../validate-request-origin.js");
    const nonce = "abc123";
    const timestamp = freshTimestamp();

    const result = await isFromQuicknode(
      makeQuicknodeRequest({
        "x-qn-nonce": nonce,
        "x-qn-timestamp": timestamp,
        "x-qn-signature": sign(nonce, timestamp, PAYLOAD),
      }),
    );

    expect(result).toBe(true);
  });

  it("accepts a fresh timestamp in milliseconds (unit tolerance)", async () => {
    const { isFromQuicknode } = await import("../validate-request-origin.js");
    const nonce = "abc123";
    const timestamp = String(Date.now());

    const result = await isFromQuicknode(
      makeQuicknodeRequest({
        "x-qn-nonce": nonce,
        "x-qn-timestamp": timestamp,
        "x-qn-signature": sign(nonce, timestamp, PAYLOAD),
      }),
    );

    expect(result).toBe(true);
  });

  it("rejects when QuickNode headers are missing — without reading any secret", async () => {
    const { isFromQuicknode } = await import("../validate-request-origin.js");

    const result = await isFromQuicknode(makeQuicknodeRequest({}));

    expect(result).toBe(false);
    expect(mockGetSecret).not.toHaveBeenCalled();
  });

  it("rejects a replayed (stale) timestamp even with a valid signature — without reading any secret", async () => {
    const { isFromQuicknode } = await import("../validate-request-origin.js");
    const nonce = "abc123";
    // 10 minutes old: outside the 5-minute replay window
    const timestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);

    const result = await isFromQuicknode(
      makeQuicknodeRequest({
        "x-qn-nonce": nonce,
        "x-qn-timestamp": timestamp,
        "x-qn-signature": sign(nonce, timestamp, PAYLOAD),
      }),
    );

    expect(result).toBe(false);
    expect(mockGetSecret).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric timestamp", async () => {
    const { isFromQuicknode } = await import("../validate-request-origin.js");
    const nonce = "abc123";
    const timestamp = "not-a-number";

    const result = await isFromQuicknode(
      makeQuicknodeRequest({
        "x-qn-nonce": nonce,
        "x-qn-timestamp": timestamp,
        "x-qn-signature": sign(nonce, timestamp, PAYLOAD),
      }),
    );

    expect(result).toBe(false);
  });

  it("cleanly rejects a malformed signature of the wrong length (no TypeError)", async () => {
    const { isFromQuicknode } = await import("../validate-request-origin.js");

    const result = await isFromQuicknode(
      makeQuicknodeRequest({
        "x-qn-nonce": "abc123",
        "x-qn-timestamp": freshTimestamp(),
        "x-qn-signature": "deadbeef", // 8 chars instead of 64
      }),
    );

    expect(result).toBe(false);
  });

  it("rejects a wrong signature of the correct length", async () => {
    const { isFromQuicknode } = await import("../validate-request-origin.js");

    const result = await isFromQuicknode(
      makeQuicknodeRequest({
        "x-qn-nonce": "abc123",
        "x-qn-timestamp": freshTimestamp(),
        "x-qn-signature": "0".repeat(64),
      }),
    );

    expect(result).toBe(false);
  });
});

describe("hasAuthToken", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetSecret.mockResolvedValue("expected-auth-token");
  });

  it("rejects when the x-auth-token header is absent — without reading any secret", async () => {
    const { hasAuthToken } = await import("../validate-request-origin.js");

    const result = await hasAuthToken({ headers: {} } as unknown as Request);

    expect(result).toBe(false);
    expect(mockGetSecret).not.toHaveBeenCalled();
  });

  it("accepts the correct auth token", async () => {
    const { hasAuthToken } = await import("../validate-request-origin.js");

    const result = await hasAuthToken({
      headers: { "x-auth-token": "expected-auth-token" },
    } as unknown as Request);

    expect(result).toBe(true);
  });

  it("rejects a wrong auth token", async () => {
    const { hasAuthToken } = await import("../validate-request-origin.js");

    const result = await hasAuthToken({
      headers: { "x-auth-token": "wrong-token" },
    } as unknown as Request);

    expect(result).toBe(false);
  });

  it("rejects a wrong auth token of the same length", async () => {
    const { hasAuthToken } = await import("../validate-request-origin.js");

    const result = await hasAuthToken({
      headers: { "x-auth-token": "expected-auth-tokeX" },
    } as unknown as Request);

    expect(result).toBe(false);
  });
});
