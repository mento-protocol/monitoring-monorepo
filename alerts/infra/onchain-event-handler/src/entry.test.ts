import type { Request, Response } from "@google-cloud/functions-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryPoolLiquidityWithdrawals } from "./entry";

describe("private retry entry point", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads without public webhook configuration", async () => {
    vi.stubEnv("QUICKNODE_SIGNING_SECRET", "");
    vi.stubEnv("MULTISIG_CONFIG", "");
    vi.stubEnv("SLACK_CHANNEL_ALERTS", "");
    vi.stubEnv("SLACK_CHANNEL_EVENTS", "");
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as unknown as Response;

    await retryPoolLiquidityWithdrawals({ method: "GET" } as Request, response);

    expect(response.status).toHaveBeenCalledWith(405);
    expect(response.send).toHaveBeenCalledWith("Method Not Allowed");
  });
});
