import type { Request, Response } from "@google-cloud/functions-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildEventContext: vi.fn(() => ({ byTransactionHash: new Map() })),
  checkPayloadSize: vi.fn(() => ({
    valid: true,
    size: 2,
    maxSize: 10 * 1024 * 1024,
  })),
  poolBurnCandidates: vi.fn(),
  hasPoolBurnLog: vi.fn(),
  configuredPoolWatches: vi.fn(),
  stagePoolBurns: vi.fn(),
  handleHealthCheck: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  processEvents: vi.fn(),
  reserveQuickNodeNonce: vi.fn(),
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
vi.mock("./pool-liquidity-withdrawal", () => ({
  configuredPoolWatches: mocks.configuredPoolWatches,
  hasPoolBurnLog: mocks.hasPoolBurnLog,
  poolBurnCandidates: mocks.poolBurnCandidates,
  stagePoolBurns: mocks.stagePoolBurns,
}));
vi.mock("./pool-liquidity-retry", () => ({
  retryPoolLiquidityWithdrawals: vi.fn(),
}));
vi.mock("./health-check", () => ({
  handleHealthCheck: mocks.handleHealthCheck,
}));
vi.mock("./logger", () => ({ logger: mocks.logger }));
vi.mock("./process-events", () => ({ processEvents: mocks.processEvents }));
vi.mock("./quicknode-replay-protection", () => ({
  reserveQuickNodeNonce: mocks.reserveQuickNodeNonce,
}));
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
    mocks.reserveQuickNodeNonce.mockResolvedValue({ valid: true });
    mocks.processEvents.mockResolvedValue({ processedEvents: [], skipped: 0 });
    mocks.poolBurnCandidates.mockReturnValue([]);
    mocks.configuredPoolWatches.mockReturnValue([
      {
        id: "polygon-eurm-usdm-lp-1",
        poolAddress: "0x93e15a22fda39fefccce82d387a09ccf030ead61",
        lpAddress: "0x3d54f9496bf5bd0afa67c80ee8bc2eeadf306381",
        token0Symbol: "EURm",
        token1Symbol: "USDm",
        token0Decimals: 18,
        token1Decimals: 18,
      },
    ]);
    mocks.hasPoolBurnLog.mockImplementation((body) =>
      body?.result?.some((log: { name?: string }) => log?.name === "Burn"),
    );
    mocks.stagePoolBurns.mockResolvedValue({ staged: [], failures: 0 });
  });

  it("acknowledges duplicate webhook nonces without processing them", async () => {
    mocks.reserveQuickNodeNonce.mockResolvedValue({
      valid: false,
      status: 200,
      message: "Duplicate webhook nonce already processed",
      replayed: true,
    });
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(mocks.processEvents).not.toHaveBeenCalled();
    expect(mocks.reserveQuickNodeNonce).toHaveBeenCalledWith(
      "nonce-1",
      "1700000000",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(
      "Duplicate webhook nonce already processed",
    );
  });

  it("does not reserve a nonce for an invalid payload", async () => {
    mocks.validatePayload.mockReturnValue({
      valid: false,
      status: 400,
      error: { error: "bad payload" },
    });
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(mocks.reserveQuickNodeNonce).not.toHaveBeenCalled();
    expect(mocks.processEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "bad payload" });
  });

  it("retries failed Watched LP staging after processing Safe logs in a mixed batch", async () => {
    const burns = [{ txHash: `0x${"ab".repeat(32)}`, logIndex: 7 }];
    const burnLog = {
      address: "0x93e15a22fda39fefccce82d387a09ccf030ead61",
      name: "Burn",
    };
    const safeLog = {
      address: "0x0000000000000000000000000000000000000001",
      name: "ExecutionSuccess",
    };
    const body = { result: [burnLog, safeLog] };
    mocks.validatePayload.mockReturnValue({ valid: true, payload: body });
    mocks.poolBurnCandidates.mockReturnValue(burns);
    mocks.stagePoolBurns.mockResolvedValue({ staged: [], failures: 1 });
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();
    await processQuicknodeWebhook(request(body), res);
    expect(mocks.stagePoolBurns).toHaveBeenCalledWith(burns);
    expect(mocks.reserveQuickNodeNonce).toHaveBeenCalledOnce();
    expect(mocks.processEvents).toHaveBeenCalledWith(
      [safeLog],
      expect.any(Object),
      expect.any(Object),
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith(
      "Watched LP withdrawal delivery failed",
    );
  });

  it("stages valid Burns and processes Safe logs despite a malformed Burn sibling", async () => {
    const burnLog = {
      address: "0x93e15a22fda39fefccce82d387a09ccf030ead61",
      name: "Burn",
    };
    const safeLog = {
      address: "0x0000000000000000000000000000000000000001",
      name: "ExecutionSuccess",
    };
    const body = { result: [burnLog, safeLog] };
    const valid = [{ txHash: `0x${"ab".repeat(32)}`, logIndex: 7 }];
    mocks.validatePayload.mockReturnValue({ valid: true, payload: body });
    mocks.poolBurnCandidates.mockImplementation((_, __, onMalformed) => {
      onMalformed();
      return valid;
    });
    mocks.stagePoolBurns.mockResolvedValue({ staged: valid, failures: 0 });
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();
    await processQuicknodeWebhook(request(body), res);
    expect(mocks.stagePoolBurns).toHaveBeenCalledWith(valid);
    expect(mocks.processEvents).toHaveBeenCalledWith(
      [safeLog],
      expect.any(Object),
      expect.any(Object),
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Watched LP Burn missing event key",
      expect.objectContaining({ reason: "pool_liquidity_malformed_burn" }),
    );
  });

  it("processes Safe logs while pool staging is stalled", async () => {
    let release!: (value: { staged: []; failures: number }) => void;
    const stalled = new Promise<{ staged: []; failures: number }>((resolve) => {
      release = resolve;
    });
    const burnLog = {
      address: "0x93e15a22fda39fefccce82d387a09ccf030ead61",
      name: "Burn",
    };
    const safeLog = {
      address: "0x0000000000000000000000000000000000000001",
      name: "ExecutionSuccess",
    };
    const body = { result: [burnLog, safeLog] };
    mocks.validatePayload.mockReturnValue({ valid: true, payload: body });
    mocks.stagePoolBurns.mockReturnValue(stalled);
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();
    const running = processQuicknodeWebhook(request(body), res);
    await vi.waitFor(() =>
      expect(mocks.processEvents).toHaveBeenCalledWith(
        [safeLog],
        expect.any(Object),
        expect.any(Object),
      ),
    );
    expect(res.status).not.toHaveBeenCalledWith(200);
    release({ staged: [], failures: 0 });
    await running;
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("processes Safe logs when the pool watch configuration is invalid", async () => {
    const safeLog = {
      address: "0x0000000000000000000000000000000000000001",
      name: "ExecutionSuccess",
    };
    const body = { result: [safeLog] };
    mocks.validatePayload.mockReturnValue({ valid: true, payload: body });
    mocks.configuredPoolWatches.mockImplementation(() => {
      throw new Error("Invalid pool watch configuration");
    });
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();
    await processQuicknodeWebhook(request(body), res);
    expect(mocks.processEvents).toHaveBeenCalledWith(
      [safeLog],
      expect.any(Object),
      expect.any(Object),
    );
    expect(mocks.configuredPoolWatches).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("keeps a failed Watched LP event retryable when the Safe nonce was already claimed", async () => {
    mocks.poolBurnCandidates.mockReturnValue([
      { txHash: `0x${"ab".repeat(32)}`, logIndex: 7 },
    ]);
    mocks.stagePoolBurns.mockResolvedValue({ staged: [], failures: 1 });
    mocks.reserveQuickNodeNonce.mockResolvedValue({
      valid: false,
      status: 200,
      message: "Duplicate webhook nonce already processed",
      replayed: true,
    });
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request({ result: [{ name: "Burn" }] }), res);

    expect(mocks.processEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith(
      "Watched LP withdrawal delivery failed",
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
