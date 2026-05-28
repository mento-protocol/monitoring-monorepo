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

async function loadValidator() {
  vi.resetModules();
  process.env.MULTISIG_CONFIG = "{}";
  process.env.QUICKNODE_SIGNING_SECRET = secret;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_CHANNEL_ALERTS = "Calerts";
  process.env.SLACK_CHANNEL_EVENTS = "Cevents";
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

  it("accepts a signed request without reserving the replay nonce", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { validateQuickNodeWebhook } = await loadValidator();

    await expect(validateQuickNodeWebhook(request())).resolves.toEqual({
      valid: true,
      nonce,
      timestamp,
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
