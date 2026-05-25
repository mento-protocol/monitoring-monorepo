import crypto from "crypto";
import type { Request } from "@google-cloud/functions-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secret = "test-secret-key";
const payload = '{"test":"data"}';
const nonce = "nonce-1";
const timestamp = "1700000000";

function sign(inputNonce = nonce, inputTimestamp = timestamp): string {
  return crypto
    .createHmac("sha256", secret)
    .update(inputNonce + inputTimestamp + payload)
    .digest("hex");
}

function request(signature = sign()): Request {
  return {
    headers: {
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": signature,
      "content-type": "application/json",
    },
    rawBody: Buffer.from(payload),
    body: JSON.parse(payload) as unknown,
  } as Request & { rawBody: Buffer };
}

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as Response;
}

async function loadValidator() {
  vi.resetModules();
  process.env.DISCORD_WEBHOOK_ALERTS = "https://discord.test/alerts";
  process.env.DISCORD_WEBHOOK_EVENTS = "https://discord.test/events";
  process.env.MULTISIG_CONFIG = "{}";
  process.env.QUICKNODE_SIGNING_SECRET = secret;
  process.env.QUICKNODE_REPLAY_BUCKET = "quicknode-replay-test";
  return import("./validate-quicknode-webhook");
}

describe("validateQuickNodeWebhook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Number(timestamp) * 1000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("accepts a signed nonce and acknowledges duplicate nonces without auth retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { access_token: "token-1" }))
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(response(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { validateQuickNodeWebhook } = await loadValidator();

    await expect(validateQuickNodeWebhook(request())).resolves.toEqual({
      valid: true,
      nonce,
      timestamp,
    });
    await expect(validateQuickNodeWebhook(request())).resolves.toEqual({
      valid: false,
      status: 200,
      message: "Duplicate webhook nonce already processed",
      replayed: true,
    });

    const uploadCall = fetchMock.mock.calls[1];
    expect(String(uploadCall[0])).toContain("/storage/v1/b/");
    expect(String(uploadCall[0])).toContain(
      "quicknode-replay-nonces%2F1700000000%2F",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the replay nonce bucket is not configured", async () => {
    const { validateQuickNodeWebhook } = await loadValidator();
    delete process.env.QUICKNODE_REPLAY_BUCKET;

    await expect(validateQuickNodeWebhook(request())).resolves.toEqual({
      valid: false,
      status: 500,
      message: "Server configuration error",
    });
  });

  it("does not reserve a nonce when the signature is invalid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { validateQuickNodeWebhook } = await loadValidator();

    await expect(
      validateQuickNodeWebhook(request("a".repeat(64))),
    ).resolves.toEqual({
      valid: false,
      status: 401,
      message: "Unauthorized: Invalid signature",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
