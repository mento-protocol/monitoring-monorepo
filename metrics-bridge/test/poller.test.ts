import { describe, it, expect, vi, beforeEach } from "vitest";
import { register } from "../src/metrics.js";
import { makePoolResponse, getGaugeValue } from "./fixtures.js";

vi.mock("../src/graphql.js", () => ({
  fetchPools: vi.fn(),
}));

vi.mock("../src/server.js", () => ({
  markHealthy: vi.fn(),
}));

vi.mock("../src/rebalance-probe.js", () => ({
  runRebalanceProbes: vi.fn().mockResolvedValue(undefined),
}));

import { poll, _resetPollCycleForTests } from "../src/poller.js";
import { fetchPools } from "../src/graphql.js";
import { markHealthy } from "../src/server.js";
import { runRebalanceProbes } from "../src/rebalance-probe.js";

const mockFetchPools = vi.mocked(fetchPools);
const mockMarkHealthy = vi.mocked(markHealthy);
const mockRunRebalanceProbes = vi.mocked(runRebalanceProbes);

describe("poll", () => {
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    _resetPollCycleForTests();
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
      chain_name: "celo",
      pair: "GBPm/USDm",
      pool_address_short: "0x8c00…cb56",
      block_explorer_url:
        "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
    });
    expect(oracleBefore).toBeDefined();

    mockFetchPools.mockRejectedValueOnce(new Error("timeout"));
    await poll();

    const oracleAfter = await getGaugeValue(register, "mento_pool_oracle_ok", {
      pool_id: "42220-0x8c0014afe032e4574481d8934504100bf23fcb56",
      chain_id: "42220",
      chain_name: "celo",
      pair: "GBPm/USDm",
      pool_address_short: "0x8c00…cb56",
      block_explorer_url:
        "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
    });
    expect(oracleAfter).toBe(oracleBefore);
  });

  it("runs the rebalance probe on the FIRST successful poll (not delayed by N polls)", async () => {
    // Otherwise an operator restarting the bridge mid-breach would wait up
    // to N×30s = 2.5 min for the reason annotation to attach.
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    await poll();
    expect(mockRunRebalanceProbes).toHaveBeenCalledTimes(1);
  });

  it("runs the rebalance probe every Nth poll (default N=5)", async () => {
    // Default REBALANCE_PROBE_EVERY_N_POLLS is 5; probe fires when
    // (cycle % 5) === 1 → cycles 1 and 6.
    for (let i = 0; i < 6; i++) {
      mockFetchPools.mockResolvedValueOnce(makePoolResponse());
      await poll();
    }
    expect(mockRunRebalanceProbes).toHaveBeenCalledTimes(2);
  });

  it("does not advance the cycle counter on a failed poll", async () => {
    // A failed Hasura fetch shouldn't slide the probe out of cadence — the
    // probe should still attach to the next SUCCESSFUL cycle.
    mockFetchPools.mockRejectedValueOnce(new Error("network"));
    await poll();
    expect(mockRunRebalanceProbes).not.toHaveBeenCalled();

    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    await poll();
    expect(mockRunRebalanceProbes).toHaveBeenCalledTimes(1);
  });

  it("does not crash the poll when the rebalance probe throws", async () => {
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    mockRunRebalanceProbes.mockRejectedValueOnce(new Error("probe boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await poll();

    expect(mockMarkHealthy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "Rebalance probe failed:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
