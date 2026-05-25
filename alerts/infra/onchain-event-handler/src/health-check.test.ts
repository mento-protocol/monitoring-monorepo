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
    delete process.env.DISCORD_WEBHOOK_ALERTS;
    delete process.env.DISCORD_WEBHOOK_EVENTS;
    delete process.env.MULTISIG_CONFIG;
    delete process.env.QUICKNODE_SIGNING_SECRET;
  });

  it("returns structured unhealthy JSON instead of throwing when env is absent", async () => {
    const { processQuicknodeWebhook } = await import("./index");
    const res = response();

    await processQuicknodeWebhook({ method: "GET" } as Request, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unhealthy",
        checks: expect.objectContaining({
          config: expect.objectContaining({
            status: "error",
            message: "Missing DISCORD_WEBHOOK_ALERTS",
          }),
        }),
      }),
    );
  });

  it("returns structured unhealthy JSON for malformed multisig config", async () => {
    process.env.DISCORD_WEBHOOK_ALERTS =
      "https://discord.com/api/webhooks/test/alerts";
    process.env.DISCORD_WEBHOOK_EVENTS =
      "https://discord.com/api/webhooks/test/events";
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
});
