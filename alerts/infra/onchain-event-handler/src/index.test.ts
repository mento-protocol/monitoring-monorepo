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
  reserveQuickNodeNonce: vi.fn(),
  validatePayload: vi.fn(),
  validateQuickNodeWebhook: vi.fn(),
}));

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
    process.env.NODE_ENV = "production";
    mocks.validateQuickNodeWebhook.mockResolvedValue({
      valid: true,
      nonce: "nonce-1",
      timestamp: "1700000000",
    });
    mocks.validatePayload.mockReturnValue({
      valid: true,
      payload: { result: [] },
    });
    mocks.processEvents.mockResolvedValue([]);
    mocks.reserveQuickNodeNonce.mockResolvedValue({ valid: true });
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
    expect(mocks.reserveQuickNodeNonce).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(
      "Duplicate webhook nonce already processed",
    );
  });

  it("does not reserve a replay nonce when downstream processing fails", async () => {
    mocks.processEvents.mockRejectedValue(new Error("temporary failure"));
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(mocks.reserveQuickNodeNonce).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith("Internal Server Error");
  });

  it("reserves the replay nonce after downstream processing succeeds", async () => {
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook(request(), res);

    expect(mocks.processEvents).toHaveBeenCalledBefore(
      mocks.reserveQuickNodeNonce,
    );
    expect(mocks.reserveQuickNodeNonce).toHaveBeenCalledWith(
      "nonce-1",
      "1700000000",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ processed: 0, total: 0 });
  });
});
