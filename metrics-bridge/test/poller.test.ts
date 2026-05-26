import { describe, it, expect, vi, beforeEach } from "vitest";
import { register } from "../src/metrics.js";
import * as metricsModule from "../src/metrics.js";
import {
  makePoolResponse,
  getGaugeValue,
  getMetricValues,
} from "./fixtures.js";

vi.mock("../src/graphql.js", () => ({
  fetchPools: vi.fn(),
}));

vi.mock("../src/server.js", () => ({
  markHealthy: vi.fn(),
}));

vi.mock("../src/rebalance-probe.js", () => ({
  runRebalanceProbes: vi.fn().mockResolvedValue(undefined),
}));

// `REBALANCE_PROBE_EVERY_N_POLLS` is read once at import time from process.env
// (see src/config.ts), so cadence-specific tests use vi.doMock + dynamic
// import to get a fresh module with the env-overridden constant. The default
// (N=5) tests use the top-level static import.
import { poll, _resetPollCycleForTests } from "../src/poller.js";
import { fetchPools } from "../src/graphql.js";
import { markHealthy } from "../src/server.js";
import { runRebalanceProbes } from "../src/rebalance-probe.js";

const mockFetchPools = vi.mocked(fetchPools);
const mockMarkHealthy = vi.mocked(markHealthy);
const mockRunRebalanceProbes = vi.mocked(runRebalanceProbes);

async function pollErrorValue(kind: string): Promise<number> {
  const values = await getMetricValues(
    register,
    "mento_pool_bridge_poll_errors_total",
  );
  return values.find((value) => value.labels.kind === kind)?.value ?? 0;
}

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

  it("increments pollErrors with hasura_query kind on fetch failure", async () => {
    mockFetchPools.mockRejectedValueOnce(new Error("network error"));
    await poll();

    expect(await pollErrorValue("hasura_query")).toBe(1);
  });

  it("increments pollErrors with update_metrics kind on metric update failure", async () => {
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    const updateSpy = vi
      .spyOn(metricsModule, "updateMetrics")
      .mockImplementationOnce(() => {
        throw new Error("metrics boom");
      });

    await poll();

    expect(await pollErrorValue("update_metrics")).toBe(1);
    updateSpy.mockRestore();
  });

  it("increments pollErrors with mark_healthy kind on health marker failure", async () => {
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    mockMarkHealthy.mockImplementationOnce(() => {
      throw new Error("health boom");
    });

    await poll();

    expect(await pollErrorValue("mark_healthy")).toBe(1);
    expect(mockRunRebalanceProbes).not.toHaveBeenCalled();
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
    // to N×30s = 2.5 min for the reason annotation to attach. Cycle 0 is
    // the cold-start invariant — must always fire regardless of N.
    mockFetchPools.mockResolvedValueOnce(makePoolResponse());
    await poll();
    expect(mockRunRebalanceProbes).toHaveBeenCalledTimes(1);
  });

  it("runs the rebalance probe every Nth poll (default N=5)", async () => {
    // Default REBALANCE_PROBE_EVERY_N_POLLS is 5; probe fires when
    // (cycle % 5) === 0 → cycles 0 and 5 across 6 polls.
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
    expect(await pollErrorValue("rebalance_probe")).toBe(1);
    errorSpy.mockRestore();
  });
});

/**
 * Cadence regression tests.
 *
 * `REBALANCE_PROBE_EVERY_N_POLLS` is captured as a const at module-load time
 * from `process.env`, so each cadence value needs a fresh module graph
 * (env stub → resetModules → dynamic import). Locks the fix for the
 * `EVERY_N=1` foot-gun (BACKLOG `Rebalance probe: handle EVERY_N=1`):
 * with the previous `(cycle % N) === 1` predicate, `cycle % 1` is always 0
 * so `=== 1` was never true and the probe silently never ran.
 */
describe("rebalance probe cadence", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    register.resetMetrics();
    vi.clearAllMocks();
  });

  async function importIsolatedPoll(): Promise<{
    poll: () => Promise<void>;
    runRebalanceProbes: ReturnType<typeof vi.fn>;
  }> {
    // Re-apply mocks against the fresh module graph that `resetModules` will
    // hand back; without this the dynamic `import("../src/poller.js")` below
    // would resolve the real graphql + rebalance-probe modules.
    vi.doMock("../src/graphql.js", () => ({ fetchPools: vi.fn() }));
    vi.doMock("../src/server.js", () => ({ markHealthy: vi.fn() }));
    vi.doMock("../src/rebalance-probe.js", () => ({
      runRebalanceProbes: vi.fn().mockResolvedValue(undefined),
    }));
    const pollerMod = await import("../src/poller.js");
    const graphqlMod = await import("../src/graphql.js");
    const probeMod = await import("../src/rebalance-probe.js");
    const isolatedFetchPools = vi.mocked(graphqlMod.fetchPools);
    const isolatedRunProbes = vi.mocked(probeMod.runRebalanceProbes);
    return {
      poll: async () => {
        isolatedFetchPools.mockResolvedValueOnce(makePoolResponse());
        await pollerMod.poll();
      },
      runRebalanceProbes: isolatedRunProbes,
    };
  }

  it("EVERY_N=1: probe runs on every successful poll (foot-gun regression)", async () => {
    // Locks the BACKLOG foot-gun fix. Pre-fix, the predicate was
    // `(cycle % N) !== 1` and `cycle % 1` is always 0, so the early-return
    // ALWAYS triggered and the probe NEVER ran with EVERY_N=1.
    vi.stubEnv("REBALANCE_PROBE_EVERY_N_POLLS", "1");
    const { poll: isolatedPoll, runRebalanceProbes: probes } =
      await importIsolatedPoll();

    for (let i = 0; i < 5; i++) await isolatedPoll();
    expect(probes).toHaveBeenCalledTimes(5);
  });

  it("EVERY_N=2: probe runs on cycles 0, 2, 4 (every 2nd poll)", async () => {
    vi.stubEnv("REBALANCE_PROBE_EVERY_N_POLLS", "2");
    const { poll: isolatedPoll, runRebalanceProbes: probes } =
      await importIsolatedPoll();

    // 6 polls → cycles 0..5 → fires on 0, 2, 4 = 3 calls.
    for (let i = 0; i < 6; i++) await isolatedPoll();
    expect(probes).toHaveBeenCalledTimes(3);
  });

  it("EVERY_N=5 (default): probe runs on cycles 0 and 5 across 6 polls", async () => {
    vi.stubEnv("REBALANCE_PROBE_EVERY_N_POLLS", "5");
    const { poll: isolatedPoll, runRebalanceProbes: probes } =
      await importIsolatedPoll();

    for (let i = 0; i < 6; i++) await isolatedPoll();
    expect(probes).toHaveBeenCalledTimes(2);
  });

  it("EVERY_N=0 is rejected by config validation and falls back to default 5", async () => {
    // Boundary check on the config parser: `>= 1` rejects 0/-1/0.5, so an
    // operator typo (`EVERY_N=0`) does NOT silently disable the probe.
    vi.stubEnv("REBALANCE_PROBE_EVERY_N_POLLS", "0");
    const configMod = await import("../src/config.js");
    expect(configMod.REBALANCE_PROBE_EVERY_N_POLLS).toBe(5);

    // And the cadence behaves as N=5 in practice — cold-start fires once
    // across 4 polls.
    const { poll: isolatedPoll, runRebalanceProbes: probes } =
      await importIsolatedPoll();
    for (let i = 0; i < 4; i++) await isolatedPoll();
    expect(probes).toHaveBeenCalledTimes(1);
  });
});
