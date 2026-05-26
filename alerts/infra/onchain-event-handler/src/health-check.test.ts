import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "@google-cloud/functions-framework";

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  res.status.mockReturnValue(res);
  return res;
}

describe("health check startup behavior", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, NODE_ENV: "development" };
    delete process.env.MULTISIG_CONFIG;
    delete process.env.QUICKNODE_SIGNING_SECRET;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_CHANNEL_ALERTS;
    delete process.env.SLACK_CHANNEL_EVENTS;
  });

  it("fails module initialization when required env is absent", async () => {
    await expect(import("./index")).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });

  it("returns structured unhealthy JSON for malformed multisig config", async () => {
    setSlackEnv();
    process.env.QUICKNODE_SIGNING_SECRET = "test-secret";
    process.env.MULTISIG_CONFIG = "{not-json";

    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook({ method: "GET" } as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unhealthy",
        checks: expect.objectContaining({
          multisigs: expect.objectContaining({
            status: "error",
            message: expect.stringContaining("Failed to parse MULTISIG_CONFIG"),
          }),
        }),
      }),
    );
  });

  it("returns structured unhealthy JSON for an empty multisig config", async () => {
    setSlackEnv();
    process.env.QUICKNODE_SIGNING_SECRET = "test-secret";
    process.env.MULTISIG_CONFIG = "{}";

    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook({ method: "GET" } as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unhealthy",
        checks: expect.objectContaining({
          multisigs: expect.objectContaining({
            status: "error",
            message: "MULTISIG_CONFIG must include at least one multisig",
          }),
        }),
      }),
    );
  });

  it("rejects webhook processing when multisig config is invalid", async () => {
    setSlackEnv();
    process.env.QUICKNODE_SIGNING_SECRET = "test-secret";
    process.env.MULTISIG_CONFIG = "{not-json";

    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook({ method: "POST" } as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Service Unavailable",
        message: expect.stringContaining("Failed to parse MULTISIG_CONFIG"),
      }),
    );
  });
});

function setSlackEnv(): void {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_CHANNEL_ALERTS = "Calerts";
  process.env.SLACK_CHANNEL_EVENTS = "Cevents";
}
