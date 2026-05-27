import type { Request, Response } from "@google-cloud/functions-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildEventContext: vi.fn(() => ({ byTransactionHash: new Map() })),
  checkPayloadSize: vi.fn(() => ({
    valid: true,
    size: 2,
    maxSize: 10 * 1024 * 1024,
  })),
  handleHealthCheck: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  processEvents: vi.fn(),
  config: {
    FUNCTION_TIMEOUT_SECONDS: undefined as string | undefined,
  },
  validatePayload: vi.fn(),
  validateQuickNodeWebhook: vi.fn(),
}));

// `./constants` evaluates `./config` at import time, which calls
// `envSchema(...)` and throws if any required Slack / multisig / QuickNode
// env vars are missing. CI runners don't have these env vars set, and tests
// should not depend on a real .env file. Mocking the module short-circuits
// the import chain so `await import("./index")` below doesn't trigger
// envSchema.
//
// MULTISIG_CONFIG_ERROR is read at index.ts:74 as a truthy/falsy gate —
// `null` keeps the test on the happy path. Tests that need to exercise the
// 503 multisig-config-error branch should override this mock per-test.
vi.mock("./constants", () => ({ MULTISIG_CONFIG_ERROR: null }));
vi.mock("./config", () => ({ default: mocks.config }));
vi.mock("./build-event-context", () => ({
  buildEventContext: mocks.buildEventContext,
}));
vi.mock("./check-payload-size", () => ({
  checkPayloadSize: mocks.checkPayloadSize,
}));
vi.mock("./health-check", () => ({
  handleHealthCheck: mocks.handleHealthCheck,
}));
vi.mock("./logger", () => ({ logger: mocks.logger }));
vi.mock("./process-events", () => ({ processEvents: mocks.processEvents }));
vi.mock("./validate-payload", () => ({
  validatePayload: mocks.validatePayload,
}));
vi.mock("./validate-quicknode-webhook", () => ({
  validateQuickNodeWebhook: mocks.validateQuickNodeWebhook,
}));

function request(body: unknown = { result: [] }): Request {
  return {
    method: "POST",
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
  } as Request;
}

function response(): Response {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as Response;
}

describe("processQuicknodeWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.FUNCTION_TIMEOUT_SECONDS = undefined;
    process.env.NODE_ENV = "production";
    process.env.MULTISIG_CONFIG = JSON.stringify({
      celoGovernance: {
        address: "0x0000000000000000000000000000000000000001",
        chain: "celo",
        name: "Celo Governance",
      },
    });
    process.env.QUICKNODE_SIGNING_SECRET = "test-secret";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ALERTS = "Calerts";
    process.env.SLACK_CHANNEL_EVENTS = "Cevents";
    mocks.validateQuickNodeWebhook.mockResolvedValue({
      valid: true,
      nonce: "nonce-1",
      timestamp: "1700000000",
    });
    mocks.validatePayload.mockReturnValue({
      valid: true,
      payload: { result: [] },
    });
    mocks.processEvents.mockResolvedValue({ processedEvents: [], skipped: 0 });
  });

  it("acknowledges duplicate webhook nonces without processing them", async () => {
    mocks.validateQuickNodeWebhook.mockResolvedValue({
      valid: false,
      status: 200,
      message: "Duplicate webhook nonce already processed",
      replayed: true,
    });
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(mocks.processEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(
      "Duplicate webhook nonce already processed",
    );
  });

  it("returns 500 when downstream processing fails after validation claimed the nonce", async () => {
    mocks.processEvents.mockRejectedValue(new Error("temporary failure"));
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith("Internal Server Error");
  });

  it("returns success after downstream processing succeeds", async () => {
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      processed: 0,
      skipped: 0,
      total: 0,
    });
  });

  it("derives processing budget from configured function timeout", async () => {
    mocks.config.FUNCTION_TIMEOUT_SECONDS = "120";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(mocks.processEvents).toHaveBeenCalledWith([], expect.any(Object), {
      budgetMs: 90_000,
      startedAtMs: 1_000,
    });
    nowSpy.mockRestore();
  });
});
