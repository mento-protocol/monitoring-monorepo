/**
 * Cycle-level tests for the rebalance probe runner — eligibility gating,
 * gauge writes, and reset semantics.
 *
 * The runner is mocked at the `probeRebalance` boundary so we don't have to
 * synthesise viem errors here (those are exercised in `rebalance-check.test.ts`).
 * The RPC client is mocked too — the runner only needs `getRpcClient` to
 * return a non-null sentinel for the chain to be considered probable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { register } from "../src/metrics.js";
import { makePool, getGaugeValue } from "./fixtures.js";

vi.mock("../src/rebalance-check.js", () => ({
  probeRebalance: vi.fn(),
  ERROR_MESSAGES: {},
}));
vi.mock("../src/rpc.js", () => ({
  getRpcClient: vi.fn(),
}));

import {
  eligibleForProbe,
  runRebalanceProbes,
} from "../src/rebalance-probe.js";
import { probeRebalance } from "../src/rebalance-check.js";
import { getRpcClient } from "../src/rpc.js";

const mockProbe = vi.mocked(probeRebalance);
const mockGetRpcClient = vi.mocked(getRpcClient);

describe("eligibleForProbe — gating mirrors the alert rule", () => {
  it("excludes pools without an active breach anchor", () => {
    const pool = makePool({
      deviationBreachStartedAt: "0",
      lastDeviationRatio: "1.50",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });

  it("excludes pools with deviation ratio == 1.05 (boundary is strict >)", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.05",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });

  it("includes pools with deviation ratio > 1.05 AND active breach", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.10",
    });
    expect(eligibleForProbe([pool])).toEqual([pool]);
  });

  it("excludes pools with the -1 deviation sentinel", () => {
    // The -1 sentinel from the indexer means "no data yet"; we must not
    // probe these even if `deviationBreachStartedAt` is anchored.
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "-1",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });

  it("excludes virtual / no-strategy pools", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.20",
      rebalancerAddress: "",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });
});

describe("runRebalanceProbes — gauge writes", () => {
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    // Default: every chain has a configured RPC client.
    mockGetRpcClient.mockReturnValue({
      call: vi.fn(),
    } as unknown as ReturnType<typeof getRpcClient>);
  });

  const breachOverrides = {
    deviationBreachStartedAt: "1713200000",
    lastDeviationRatio: "1.50",
  };

  it("emits gauge=1 with reason_code + reason_message labels on a blocked probe", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral to rebalance",
    });

    await runRebalanceProbes([pool]);

    const value = await getGaugeValue(
      register,
      "mento_pool_rebalance_blocked",
      {
        pool_id: pool.id,
        chain_id: "42220",
        chain_name: "celo",
        pair: "GBPm/USDm",
        pool_address_short: "0x8c00…cb56",
        block_explorer_url:
          "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
        reason_code: "RLS_RESERVE_OUT_OF_COLLATERAL",
        reason_message: "Reserve has insufficient collateral to rebalance",
      },
    );
    expect(value).toBe(1);
  });

  it("emits no metric on an ok probe (the rebalancer can act)", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({ kind: "ok" });

    await runRebalanceProbes([pool]);

    const metrics = await register.getMetricsAsJSON();
    const blocked = metrics.find(
      (m) => m.name === "mento_pool_rebalance_blocked",
    );
    // Either the metric is absent entirely, or its values array is empty.
    if (blocked && "values" in blocked) {
      expect((blocked as { values: unknown[] }).values).toEqual([]);
    }
  });

  it("emits no metric and logs on a transport_error", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "transport_error",
      error: "fetch failed",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRebalanceProbes([pool]);

    const metrics = await register.getMetricsAsJSON();
    const blocked = metrics.find(
      (m) => m.name === "mento_pool_rebalance_blocked",
    );
    if (blocked && "values" in blocked) {
      expect((blocked as { values: unknown[] }).values).toEqual([]);
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[REBALANCE_PROBE_FAILED]"),
    );
    warn.mockRestore();
  });

  it("emits no metric when the chain has no RPC client configured", async () => {
    const pool = makePool({
      ...breachOverrides,
      chainId: 99999,
      id: "99999-0xabc0000000000000000000000000000000000001",
    });
    mockGetRpcClient.mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRebalanceProbes([pool]);

    expect(mockProbe).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[REBALANCE_PROBE_FAILED]"),
    );
    warn.mockRestore();
  });

  it("clears stale labels each cycle (recovered pools drop out immediately)", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral to rebalance",
    });

    // First probe: pool is blocked, gauge gets written.
    await runRebalanceProbes([pool]);
    let metrics = await register.getMetricsAsJSON();
    let blocked = metrics.find(
      (m) => m.name === "mento_pool_rebalance_blocked",
    );
    expect((blocked as { values: unknown[] }).values).not.toEqual([]);

    // Second probe: pool recovered (`ok`). The gauge MUST drop the prior
    // label set so the alert annotation evaporates immediately.
    mockProbe.mockResolvedValueOnce({ kind: "ok" });
    await runRebalanceProbes([pool]);
    metrics = await register.getMetricsAsJSON();
    blocked = metrics.find((m) => m.name === "mento_pool_rebalance_blocked");
    if (blocked && "values" in blocked) {
      expect((blocked as { values: unknown[] }).values).toEqual([]);
    }
  });

  it("updates rebalanceProbeLastRun even when no pools are eligible", async () => {
    // Self-monitoring contract: the gauge bumps every cycle (or every cycle
    // where the runner ran), so an absence of probes for many cycles is
    // visible in Prometheus without needing the metric to be 1.
    const pool = makePool(); // healthy — not eligible
    const before = Math.floor(Date.now() / 1000);
    await runRebalanceProbes([pool]);
    const after = Math.floor(Date.now() / 1000);
    expect(mockProbe).not.toHaveBeenCalled();

    const value = await getGaugeValue(
      register,
      "mento_pool_rebalance_probe_last_run",
    );
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it("preserves the rebalanceBlocked gauge across the regular Hasura poll reset", async () => {
    // Regression guard: poll updateMetrics() resets the bulk of the gauge
    // registry each cycle, but rebalanceBlocked has its own lifecycle (it
    // resets every PROBE cycle, not every poll cycle). Without this
    // exclusion the alert annotation would flicker off most of the time.
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "LS_COOLDOWN_ACTIVE",
      reasonMessage: "Rebalance cooldown is active — retry shortly",
    });
    await runRebalanceProbes([pool]);

    // Now run a regular updateMetrics() — simulating a Hasura poll between probes.
    const { updateMetrics } = await import("../src/metrics.js");
    updateMetrics([pool]);

    const value = await getGaugeValue(
      register,
      "mento_pool_rebalance_blocked",
      {
        pool_id: pool.id,
        chain_id: "42220",
        chain_name: "celo",
        pair: "GBPm/USDm",
        pool_address_short: "0x8c00…cb56",
        block_explorer_url:
          "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
        reason_code: "LS_COOLDOWN_ACTIVE",
        reason_message: "Rebalance cooldown is active — retry shortly",
      },
    );
    expect(value).toBe(1);
  });
});
