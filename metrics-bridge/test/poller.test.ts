import { describe, it, expect, vi, beforeEach } from "vitest";
import { register } from "../src/metrics.js";
import { makePoolResponse, getGaugeValue } from "./fixtures.js";

vi.mock("../src/graphql.js", () => ({
  fetchPools: vi.fn(),
}));

vi.mock("../src/server.js", () => ({
  markHealthy: vi.fn(),
}));

import { poll } from "../src/poller.js";
import { fetchPools } from "../src/graphql.js";
import { markHealthy } from "../src/server.js";

const mockFetchPools = vi.mocked(fetchPools);
const mockMarkHealthy = vi.mocked(markHealthy);

describe("poll", () => {
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
  });

  it("updates bridgeLastPoll on success", async () => {
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    const before = Math.floor(Date.now() / 1000);
    await poll();
    const after = Math.floor(Date.now() / 1000);

    const value = await getGaugeValue(register, "mento_pool_bridge_last_poll");
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it("calls markHealthy on success", async () => {
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    await poll();
    expect(mockMarkHealthy).toHaveBeenCalledOnce();
  });

  it("increments pollErrors on failure", async () => {
    mockFetchPools.mockRejectedValueOnce(new Error("network error"));
    await poll();

    const value = await getGaugeValue(
      register,
      "mento_pool_bridge_poll_errors_total",
    );
    expect(value).toBe(1);
  });

  it("does not call markHealthy on failure", async () => {
    mockFetchPools.mockRejectedValueOnce(new Error("network error"));
    await poll();
    expect(mockMarkHealthy).not.toHaveBeenCalled();
  });

  it("preserves previous gauge values after failure", async () => {
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    await poll();

    const oracleBefore = await getGaugeValue(register, "mento_pool_oracle_ok", {
      pool_id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
      chain_id: "42220",
      pair: "USDm/GBPm",
    });
    expect(oracleBefore).toBeDefined();

    mockFetchPools.mockRejectedValueOnce(new Error("timeout"));
    await poll();

    const oracleAfter = await getGaugeValue(register, "mento_pool_oracle_ok", {
      pool_id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
      chain_id: "42220",
      pair: "USDm/GBPm",
    });
    expect(oracleAfter).toBe(oracleBefore);
  });
});
