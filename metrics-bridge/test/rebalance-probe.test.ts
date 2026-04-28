/**
 * Cycle-level tests for the rebalance probe runner — eligibility gating,
 * gauge writes, and reset semantics.
 *
 * The runner is mocked at the `probeRebalance` boundary so we don't have to
 * synthesise viem errors here (those are exercised in `rebalance-check.test.ts`).
 * The RPC client is mocked too — the runner only needs `getRpcClient` to
 * return a non-null sentinel for the chain to be considered probable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { register } from "../src/metrics.js";
import { REBALANCE_PROBE_TIMEOUT_MS } from "../src/config.js";
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
  runWithConcurrency,
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

  // Boundary cases — locks the `>` (NOT `>=`) semantics. The alert
  // rule's threshold is strict >, so the probe MUST stay aligned to
  // avoid annotating pools that aren't actually firing the critical
  // rule.
  it("includes ratio just above 1.05 (1.0500000001)", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.0500000001",
    });
    expect(eligibleForProbe([pool])).toEqual([pool]);
  });

  it("excludes ratio == 1.05 exactly", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.05",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });

  it("excludes ratio just below 1.05 (1.0499999999)", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.0499999999",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });

  // NaN guard — a corrupt indexer payload must not crash the runner or
  // sneak past the threshold check via NaN comparison semantics.
  it("excludes pools with empty-string deviation ratio", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });

  it("excludes pools with non-numeric deviation ratio (NaN)", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "abc",
    });
    expect(eligibleForProbe([pool])).toEqual([]);
  });
});

describe("runWithConcurrency — bounded fan-out", () => {
  it("preserves input order even when later items resolve first", async () => {
    // Queue up 7 fake "probes" with staggered resolution timings — items
    // 0..2 take longer than 3..6 — and assert results land in input
    // order so callers can correlate `results[i]` ↔ `eligible[i]`.
    const items = Array.from({ length: 7 }, (_, i) => i);
    const results = await runWithConcurrency(items, 3, async (i) => {
      // Earlier items stall; later items return immediately. If the
      // runner mistakenly indexed by completion order, this would scramble.
      await new Promise((r) => setTimeout(r, i < 3 ? 5 : 0));
      return i * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("caps simultaneous in-flight work to the concurrency parameter", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 7 }, (_, i) => i);
    await runWithConcurrency(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield twice so other workers have a chance to enter the critical
      // section concurrently — the runner is bounded to 3, so peak must
      // never exceed 3 even under heavy interleaving.
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it("drains all items even when the worker rejects", async () => {
    // The runner currently surfaces the rejection (no per-item
    // try/catch), so a single bad item rejects the whole call. The
    // probe runner sidesteps this by always RESOLVING with a
    // `transport_error` result — but if `probeOne` is ever changed to
    // `throw`, we need to know. This test pins the current behaviour:
    // one rejection cancels the batch.
    const items = [0, 1, 2, 3, 4, 5, 6];
    await expect(
      runWithConcurrency(items, 3, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow(/boom/);
  });
});

describe("runRebalanceProbes — timeout race", () => {
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    mockGetRpcClient.mockReturnValue({
      call: vi.fn(),
    } as unknown as ReturnType<typeof getRpcClient>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("races a never-resolving probe against the wall-clock timeout and surfaces transport_error", async () => {
    // Fake timers let us drive the setTimeout in `probeOne` past
    // `REBALANCE_PROBE_TIMEOUT_MS` without burning real wall time.
    vi.useFakeTimers();
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });
    // Probe never resolves — only the timeout branch can win the race.
    mockProbe.mockImplementationOnce(() => new Promise(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const probePromise = runRebalanceProbes([pool]);
    // Advance one tick past the configured timeout so the setTimeout
    // callback in probeOne fires, then let any chained microtasks settle.
    await vi.advanceTimersByTimeAsync(REBALANCE_PROBE_TIMEOUT_MS + 1);
    await probePromise;

    // No metric written — transport_error never sets the gauge.
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    warn.mockRestore();
  });
});

describe("runRebalanceProbes — re-entrancy / overlapping cycles", () => {
  // Documented behaviour: `runRebalanceProbes` is NOT mutex-protected.
  // The poller schedules cycles at fixed intervals; if a probe call
  // outlives the next interval (e.g. a stuck endpoint that the timeout
  // hasn't cancelled because of the AbortController gap tracked in
  // BACKLOG.md "Rebalance probe: AbortController for timed-out RPC
  // calls"), cycles can overlap. The runner resets the gauge at the
  // start of every cycle, so a late `set(...)` from cycle N-1 can land
  // AFTER cycle N has reset the gauge but BEFORE cycle N has written
  // its own results — leaving the alert annotation showing stale
  // labels for the duration of cycle N.
  //
  // This test EXPOSES the limitation rather than asserting correct
  // behaviour: fixing it requires either a per-cycle epoch tag on the
  // gauge writes or wrapping the runner in a mutex, both of which need
  // a design discussion before shipping. Tracked in BACKLOG.md.
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    mockGetRpcClient.mockReturnValue({
      call: vi.fn(),
    } as unknown as ReturnType<typeof getRpcClient>);
  });

  it("documents the known limitation: late cycle-N-1 results stomp cycle-N gauge state", async () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });

    // Cycle N-1: probe resolves with stale data (kept pending until we
    // explicitly resolve below to simulate "outlived its cycle").
    let resolveCycle1: (v: {
      kind: "blocked";
      reasonCode: string;
      reasonMessage: string;
    }) => void = () => {};
    const cycle1Probe = new Promise<{
      kind: "blocked";
      reasonCode: string;
      reasonMessage: string;
    }>((r) => {
      resolveCycle1 = r;
    });
    mockProbe.mockReturnValueOnce(
      cycle1Probe as unknown as ReturnType<typeof probeRebalance>,
    );

    // Cycle N: probe resolves immediately with a different reason.
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "LS_INVALID_PRICES",
      reasonMessage: "Oracle price data is invalid or stale",
    });

    // Kick off both cycles without awaiting cycle 1.
    const cycle1Run = runRebalanceProbes([pool]);
    // Cycle 2 starts before cycle 1 resolves, resets the gauge, awaits
    // its own probe (which resolves immediately), and writes its
    // labels.
    await runRebalanceProbes([pool]);

    // At this point cycle 2's labels are present.
    let value = await getGaugeValue(register, "mento_pool_rebalance_blocked", {
      reason_code: "LS_INVALID_PRICES",
    });
    expect(value).toBe(1);

    // Cycle 1 finally resolves — ITS late write lands on top of cycle
    // 2's gauge state, restoring the stale label set. This is the
    // limitation documented above.
    resolveCycle1({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral to rebalance",
    });
    await cycle1Run;

    value = await getGaugeValue(register, "mento_pool_rebalance_blocked", {
      reason_code: "RLS_RESERVE_OUT_OF_COLLATERAL",
    });
    // The stale cycle-1 result has stomped cycle-2's gauge — locked here
    // as a known issue so the test breaks (forcing a design decision)
    // when someone adds AbortController + cycle-epoch protection.
    expect(value).toBe(1);
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

  it("emits no metric and logs on a 'skip' (unknown strategy)", async () => {
    // OLS guard: when the strategy can't be identified, we must NOT emit
    // a misleading "blocked" annotation in Slack. Instead the probe is
    // skipped and a one-off log line surfaces the unidentified strategy
    // so an operator can investigate.
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "skip",
      reason: "Unable to identify the liquidity strategy type",
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
      expect.stringContaining("[REBALANCE_PROBE_SKIPPED]"),
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

  it("logs the diagnostic detail on a blocked probe with operator-only context", async () => {
    // The bounded `reason_message` label keeps Slack alerts cardinality-safe,
    // but operators investigating "Reverted with revert string" or
    // "Solidity panic" need the unbounded payload — we route it to Cloud
    // Run logs via the `[REBALANCE_PROBE_DIAGNOSTIC]` line.
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "Error",
      reasonMessage: "Reverted with revert string",
      diagnostic: 'Error(string) payload: "*pwned*"',
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRebalanceProbes([pool]);

    // Metric label stays bounded: operator-supplied raw string is NOT in the
    // gauge label set.
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
        reason_code: "Error",
        reason_message: "Reverted with revert string",
      },
    );
    expect(value).toBe(1);
    // Diagnostic detail surfaced to logs only — never to labels.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[REBALANCE_PROBE_DIAGNOSTIC]"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("*pwned*"));
    warn.mockRestore();
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

describe("runRebalanceProbes — reserve-collateral enrichment gauges", () => {
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    mockGetRpcClient.mockReturnValue({
      call: vi.fn(),
    } as unknown as ReturnType<typeof getRpcClient>);
  });

  const breachOverrides = {
    deviationBreachStartedAt: "1713200000",
    lastDeviationRatio: "1.50",
  };

  it("emits collateral_balance + collateral_needed with token_symbol on RLS_RESERVE_OUT_OF_COLLATERAL", async () => {
    // The Slack annotation reads `$values.Bal` / `$values.Need` plus
    // `$values.Bal.Labels.token_symbol`. Both gauges MUST land with the
    // pool fingerprint AND a populated token_symbol so the annotation
    // template renders.
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient axlUSDC",
      reserveCollateral: {
        balance: 0,
        needed: 12_500,
        tokenSymbol: "axlUSDC",
      },
    });

    await runRebalanceProbes([pool]);

    const balance = await getGaugeValue(
      register,
      "mento_pool_rebalance_collateral_balance",
      {
        pool_id: pool.id,
        chain_id: "42220",
        chain_name: "celo",
        pair: "GBPm/USDm",
        pool_address_short: "0x8c00…cb56",
        block_explorer_url:
          "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
        token_symbol: "axlUSDC",
      },
    );
    expect(balance).toBe(0);

    const needed = await getGaugeValue(
      register,
      "mento_pool_rebalance_collateral_needed",
      {
        pool_id: pool.id,
        chain_id: "42220",
        chain_name: "celo",
        pair: "GBPm/USDm",
        pool_address_short: "0x8c00…cb56",
        block_explorer_url:
          "https://celoscan.io/address/0x8c0014afe032e4574481d8934504100bf23fcb56",
        token_symbol: "axlUSDC",
      },
    );
    expect(needed).toBe(12_500);
  });

  it("does NOT emit enrichment gauges for non-reserve strategy reasons (CDP)", async () => {
    // Probe attaches `reserveCollateral` only for RLS_RESERVE_OUT_OF_COLLATERAL
    // — CDP / OLS / unknown reasons must leave both gauges absent so the
    // Slack annotation falls back to the generic reason_message line.
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW",
      reasonMessage:
        "Stability pool has insufficient liquidity to fully rebalance",
    });

    await runRebalanceProbes([pool]);

    const metrics = await register.getMetricsAsJSON();
    const balanceMetric = metrics.find(
      (m) => m.name === "mento_pool_rebalance_collateral_balance",
    );
    const neededMetric = metrics.find(
      (m) => m.name === "mento_pool_rebalance_collateral_needed",
    );
    if (balanceMetric && "values" in balanceMetric) {
      expect((balanceMetric as { values: unknown[] }).values).toEqual([]);
    }
    if (neededMetric && "values" in neededMetric) {
      expect((neededMetric as { values: unknown[] }).values).toEqual([]);
    }
  });

  it("does NOT emit enrichment gauges on OLS_OUT_OF_COLLATERAL (different strategy type)", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "OLS_OUT_OF_COLLATERAL",
      reasonMessage:
        "Strategy has no collateral liquidity available to rebalance",
    });

    await runRebalanceProbes([pool]);

    const metrics = await register.getMetricsAsJSON();
    const balanceMetric = metrics.find(
      (m) => m.name === "mento_pool_rebalance_collateral_balance",
    );
    if (balanceMetric && "values" in balanceMetric) {
      expect((balanceMetric as { values: unknown[] }).values).toEqual([]);
    }
  });

  it("clears stale enrichment labels each cycle (recovered pools drop out immediately)", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient axlUSDC",
      reserveCollateral: {
        balance: 0,
        needed: 12_500,
        tokenSymbol: "axlUSDC",
      },
    });

    await runRebalanceProbes([pool]);
    let metrics = await register.getMetricsAsJSON();
    let balance = metrics.find(
      (m) => m.name === "mento_pool_rebalance_collateral_balance",
    );
    expect((balance as { values: unknown[] }).values).not.toEqual([]);

    // Pool recovered (`ok`); both enrichment gauges MUST drop.
    mockProbe.mockResolvedValueOnce({ kind: "ok" });
    await runRebalanceProbes([pool]);
    metrics = await register.getMetricsAsJSON();
    balance = metrics.find(
      (m) => m.name === "mento_pool_rebalance_collateral_balance",
    );
    if (balance && "values" in balance) {
      expect((balance as { values: unknown[] }).values).toEqual([]);
    }
  });
});
