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
  // `probeOne` calls `isAbortError` to detect a timeout-driven abort vs.
  // an unexpected throw — duplicate the implementation here so the mock
  // exports the same shape.
  isAbortError: (err: unknown) => {
    if (!err || typeof err !== "object") return false;
    const e = err as { name?: string; code?: string };
    return e.name === "AbortError" || e.code === "ABORT_ERR";
  },
  // `probeOne` calls `scrubUrls` on the fallback error message path.
  scrubUrls: (s: string) =>
    s.replace(/https?:\/\/[^\s)]+/gi, "<rpc-url-redacted>"),
  ERROR_MESSAGES: {},
}));
vi.mock("../src/rpc.js", () => ({
  getRpcClient: vi.fn(),
}));

import {
  eligibleForProbe,
  runRebalanceProbes,
  runWithConcurrency,
  _resetProbeInProgressForTests,
} from "../src/rebalance-probe.js";
import { probeRebalance } from "../src/rebalance-check.js";
import { getRpcClient } from "../src/rpc.js";

const mockProbe = vi.mocked(probeRebalance);
const mockGetRpcClient = vi.mocked(getRpcClient);

describe("eligibleForProbe — gating mirrors the critical alert rule", () => {
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

  it("includes de-escalated pools whose open breach previously crossed critical", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.03",
      currentOpenBreachPeak: "15000",
      currentOpenBreachEntryThreshold: 10000,
    });
    expect(eligibleForProbe([pool])).toEqual([pool]);
  });

  it("excludes recovered pools even when the open-breach peak is still populated", () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.01",
      currentOpenBreachPeak: "15000",
      currentOpenBreachEntryThreshold: 10000,
    });
    expect(eligibleForProbe([pool])).toEqual([]);
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
    _resetProbeInProgressForTests();
    mockGetRpcClient.mockReturnValue({
      call: vi.fn(),
    } as unknown as ReturnType<typeof getRpcClient>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signals abort on wall-clock timeout so the runner stops awaiting and surfaces transport_error", async () => {
    // Fake timers let us drive the setTimeout in `probeOne` past
    // `REBALANCE_PROBE_TIMEOUT_MS` without burning real wall time.
    vi.useFakeTimers();
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });
    // Probe observes the signal and rejects on abort. This is what the
    // signal-aware `abortable()` wrappers buy us: the runner short-circuits
    // detection / simulation / enrichment instead of awaiting orphaned
    // promises. (Note: viem 2.47.0 doesn't accept a per-call signal so the
    // underlying HTTP fetch keeps running until the transport timeout — the
    // JS-visible promise rejection is the load-bearing change here.)
    let observedSignal: AbortSignal | undefined;
    mockProbe.mockImplementationOnce((_client, _pool, _strategy, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const probePromise = runRebalanceProbes([pool]);
    // Advance one tick past the configured timeout so the setTimeout
    // callback in probeOne fires, then let any chained microtasks settle.
    await vi.advanceTimersByTimeAsync(REBALANCE_PROBE_TIMEOUT_MS + 1);
    await probePromise;

    // The runner threaded an AbortSignal into the probe and that signal
    // is now aborted (the wall-clock timeout fired controller.abort()).
    // The legacy `Promise.race` left the runner blocked on the viem call;
    // this assertion proves the runner now stops awaiting on timeout.
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);

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

  it("clears the timeout handle when the probe completes successfully (no leaked timers)", async () => {
    // Run N successful probes back-to-back and assert that each cycle's
    // timeout handles are released. Without `clearTimeout` in the success
    // branch, every probe leaks a setTimeout that fires later (no-op,
    // but pinned event-loop work and a Node `process._getActiveHandles`
    // entry per probe). At REBALANCE_PROBE_CONCURRENCY=5 against a
    // healthy endpoint the leak rate would be ≈10 handles/min/probe-pool
    // — small but real.
    vi.useFakeTimers();
    const pools = Array.from({ length: 5 }, (_, i) =>
      makePool({
        id: `42220-0xabc000000000000000000000000000000000000${i}`,
        deviationBreachStartedAt: "1713200000",
        lastDeviationRatio: "1.50",
      }),
    );
    // Every probe resolves immediately with `ok` — the success branch
    // must clear its timeout handle in `finally`.
    mockProbe.mockResolvedValue({ kind: "ok" });

    await runRebalanceProbes(pools);

    // After the runner returns, advancing the clock past the configured
    // timeout MUST NOT trigger any pending callbacks — proves all
    // setTimeout handles were cleared on the success path.
    expect(vi.getTimerCount()).toBe(0);

    // Belt-and-braces: advance well past the timeout — should be a no-op.
    await vi.advanceTimersByTimeAsync(REBALANCE_PROBE_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scrubs RPC URLs from the error message in the unexpected-error fallback", async () => {
    // Regression guard for the fallback catch in `probeOne`: any non-abort
    // error that escapes `probeRebalance` must have its message URL-scrubbed
    // before appearing in `[REBALANCE_PROBE_FAILED]` logs. Without this,
    // viem transport errors containing path-based API keys (e.g.
    // "https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY") would leak
    // credentials into Cloud Run logs.
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });
    const urlInError = new Error(
      "HTTP request failed. URL: https://eth-mainnet.g.alchemy.com/v2/SECRET_API_KEY_12345",
    );
    // Throw a plain (non-abort) Error so the fallback catch branch is hit.
    mockProbe.mockRejectedValueOnce(urlInError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRebalanceProbes([pool]);

    // The raw URL must never appear in the log line.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[REBALANCE_PROBE_FAILED]"),
    );
    const logged = warn.mock.calls
      .filter((args) => String(args[0]).includes("[REBALANCE_PROBE_FAILED]"))
      .map((args) => String(args[0]))
      .join("\n");
    expect(logged).not.toContain("SECRET_API_KEY_12345");
    expect(logged).toContain("<rpc-url-redacted>");
    warn.mockRestore();
  });

  it("truncates unexpected probe errors before logging", async () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });
    const longMessage = `transport ${"x".repeat(260)}`;
    mockProbe.mockRejectedValueOnce(new Error(longMessage));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRebalanceProbes([pool]);

    const logged = warn.mock.calls
      .filter((args) => String(args[0]).includes("[REBALANCE_PROBE_FAILED]"))
      .map((args) => String(args[0]))
      .join("\n");
    const loggedError = logged.split(" error=")[1] ?? "";
    expect(loggedError).toHaveLength(200);
    expect(loggedError).toBe(longMessage.slice(0, 200));
    warn.mockRestore();
  });

  it("does not throw an AbortError downstream when the probe completes successfully", async () => {
    // Regression guard: a probe that finishes BEFORE the timeout fires
    // must surface its result cleanly. Even if the abort eventually
    // happens (e.g. between micro-task ticks), it lands on a controller
    // nobody's awaiting, so it can't pollute the result.
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runRebalanceProbes([pool])).resolves.toBeUndefined();

    // The blocked label set landed; no transport_error was logged.
    const value = await getGaugeValue(
      register,
      "mento_pool_rebalance_blocked",
      { reason_code: "RLS_RESERVE_OUT_OF_COLLATERAL" },
    );
    expect(value).toBe(1);
    const failedCalls = warn.mock.calls.filter((args) =>
      String(args[0]).includes("[REBALANCE_PROBE_FAILED]"),
    );
    expect(failedCalls).toHaveLength(0);
    warn.mockRestore();
  });
});

describe("runRebalanceProbes — re-entrancy guard for overlapping cycles", () => {
  // The runner is gated by a module-scope `probeInProgress` mutex.
  // Production today serialises cycles (the poller awaits each call
  // before scheduling the next), so this guard is a safety rail for
  // future restructures — e.g. an AbortController fast-cancel path
  // that could reorder completion, or a parallel timer caller. When a
  // second cycle starts while cycle N-1 is still in flight, the guard
  // makes cycle N a no-op: it returns immediately, no probes run, no
  // gauge state is touched, and a single warn surfaces the skip.
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    _resetProbeInProgressForTests();
    mockGetRpcClient.mockReturnValue({
      call: vi.fn(),
    } as unknown as ReturnType<typeof getRpcClient>);
  });

  it("skips overlapping cycles and preserves the in-flight cycle's state", async () => {
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });

    // Cycle N-1: probe stays pending until we explicitly resolve below
    // to simulate "outlived its cycle" — i.e. cycle N starts while
    // cycle N-1's probe hasn't returned.
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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Kick off cycle 1 without awaiting — leaves it pinned in the
    // pending-promise state with `probeInProgress === true`.
    const cycle1Run = runRebalanceProbes([pool]);

    // Cycle 2 fires while cycle 1 is mid-flight. The mutex guard MUST
    // make this a no-op — no probe call, no gauge mutation, just the
    // warn-once log. We give the runner a microtask to schedule the
    // probe call before we assert.
    await runRebalanceProbes([pool]);

    // Only cycle 1 enqueued a probe; cycle 2 short-circuited.
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[REBALANCE_PROBE_REENTRY]"),
    );

    // Gauge state must still be empty: cycle 1 hasn't written yet
    // (probe still pending), and cycle 2 was a no-op — no reset, no
    // writes, nothing for cycle 1 to land on top of.
    let metrics = await register.getMetricsAsJSON();
    let blocked = metrics.find(
      (m) => m.name === "mento_pool_rebalance_blocked",
    );
    if (blocked && "values" in blocked) {
      expect((blocked as { values: unknown[] }).values).toEqual([]);
    }

    // Resolve cycle 1's probe and let it finish writing its labels.
    resolveCycle1({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral",
    });
    await cycle1Run;

    // Cycle 1's result is now reflected in the gauge — exactly once,
    // with no double-execution from cycle 2.
    expect(mockProbe).toHaveBeenCalledTimes(1);
    const value = await getGaugeValue(
      register,
      "mento_pool_rebalance_blocked",
      { reason_code: "RLS_RESERVE_OUT_OF_COLLATERAL" },
    );
    expect(value).toBe(1);

    // The gauge holds cycle 1's labels — never any others.
    metrics = await register.getMetricsAsJSON();
    blocked = metrics.find((m) => m.name === "mento_pool_rebalance_blocked");
    expect(
      (blocked as { values: { labels: { reason_code: string } }[] }).values.map(
        (v) => v.labels.reason_code,
      ),
    ).toEqual(["RLS_RESERVE_OUT_OF_COLLATERAL"]);

    warn.mockRestore();
  });

  it("warns once per busy window even when many cycles overlap, and re-arms after release", async () => {
    // A wedged in-flight cycle could attract dozens of repeated skips. The
    // contract is one warn per "stuck" window — not one per skipped call —
    // so the log doesn't bury more useful per-pool diagnostic lines. After
    // the in-flight cycle resolves, the latch re-arms so a future overlap
    // surfaces a fresh log line.
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });

    // Cycle 1 stays pending so the next two calls re-enter.
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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cycle1Run = runRebalanceProbes([pool]);
    // Cycles 2 and 3 both re-enter while cycle 1 is in flight.
    await runRebalanceProbes([pool]);
    await runRebalanceProbes([pool]);

    // Only one re-entry warn for the busy window — not two.
    const reentryWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("[REBALANCE_PROBE_REENTRY]"),
    );
    expect(reentryWarns).toHaveLength(1);

    // Resolve cycle 1 to release the latch.
    resolveCycle1({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral",
    });
    await cycle1Run;

    // A NEW busy window: cycle 4 stays pending, cycle 5 re-enters. The latch
    // must have re-armed so this surfaces a fresh log line.
    let resolveCycle4: (v: {
      kind: "blocked";
      reasonCode: string;
      reasonMessage: string;
    }) => void = () => {};
    const cycle4Probe = new Promise<{
      kind: "blocked";
      reasonCode: string;
      reasonMessage: string;
    }>((r) => {
      resolveCycle4 = r;
    });
    mockProbe.mockReturnValueOnce(
      cycle4Probe as unknown as ReturnType<typeof probeRebalance>,
    );
    const cycle4Run = runRebalanceProbes([pool]);
    await runRebalanceProbes([pool]);

    const reentryWarnsAfter = warn.mock.calls.filter((c) =>
      String(c[0]).includes("[REBALANCE_PROBE_REENTRY]"),
    );
    expect(reentryWarnsAfter).toHaveLength(2);

    resolveCycle4({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral",
    });
    await cycle4Run;

    warn.mockRestore();
  });

  it("releases the mutex when a probe throws so the next cycle can run", async () => {
    // The `try { ... } finally { probeInProgress = false }` contract is the
    // load-bearing piece of the guard: if a probe rejection left the flag
    // stuck `true`, the probe would be permanently disabled until the
    // process restarted. Pin it.
    //
    // Since PR #241 `probeOne` wraps unexpected throws in a `transport_error`
    // result rather than re-throwing, so `runRebalanceProbes` resolves (not
    // rejects) and logs a `[REBALANCE_PROBE_FAILED]` line with the message.
    const pool = makePool({
      deviationBreachStartedAt: "1713200000",
      lastDeviationRatio: "1.50",
    });
    mockProbe.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Cycle 1 surfaces the throw as transport_error — resolves, not rejects.
    await runRebalanceProbes([pool]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[REBALANCE_PROBE_FAILED]"),
    );

    // Cycle 2 must run a fresh probe — the mutex was released by `finally`.
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral",
    });
    await runRebalanceProbes([pool]);

    expect(mockProbe).toHaveBeenCalledTimes(2);
    const reentryWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("[REBALANCE_PROBE_REENTRY]"),
    );
    expect(reentryWarns).toHaveLength(0);
    const value = await getGaugeValue(
      register,
      "mento_pool_rebalance_blocked",
      { reason_code: "RLS_RESERVE_OUT_OF_COLLATERAL" },
    );
    expect(value).toBe(1);
    warn.mockRestore();
  });
});

describe("runRebalanceProbes — gauge writes", () => {
  beforeEach(() => {
    register.resetMetrics();
    vi.clearAllMocks();
    _resetProbeInProgressForTests();
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
      reasonMessage: "Reserve has insufficient collateral",
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
        reason_message: "Reserve has insufficient collateral",
      },
    );
    expect(value).toBe(1);
  });

  it("does not log a diagnostic line for blocked probes without diagnostic detail", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRebalanceProbes([pool]);

    expect(warn.mock.calls).not.toEqual(
      expect.arrayContaining([
        [expect.stringContaining("[REBALANCE_PROBE_DIAGNOSTIC]")],
      ]),
    );
    warn.mockRestore();
  });

  it("emits no metric on an ok probe (the rebalancer can act)", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({ kind: "ok" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRebalanceProbes([pool]);

    const metrics = await register.getMetricsAsJSON();
    const blocked = metrics.find(
      (m) => m.name === "mento_pool_rebalance_blocked",
    );
    // Either the metric is absent entirely, or its values array is empty.
    if (blocked && "values" in blocked) {
      expect((blocked as { values: unknown[] }).values).toEqual([]);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no rpc client for chain"),
    );
    warn.mockRestore();
  });

  it("clears stale labels each cycle (recovered pools drop out immediately)", async () => {
    const pool = makePool(breachOverrides);
    mockProbe.mockResolvedValueOnce({
      kind: "blocked",
      reasonCode: "RLS_RESERVE_OUT_OF_COLLATERAL",
      reasonMessage: "Reserve has insufficient collateral",
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

  it("records rebalanceProbeLastRun in Unix seconds after an eligible probe cycle", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-04-15T12:00:00Z"));
      const pool = makePool(breachOverrides);
      mockProbe.mockResolvedValueOnce({ kind: "ok" });

      await runRebalanceProbes([pool]);

      const value = await getGaugeValue(
        register,
        "mento_pool_rebalance_probe_last_run",
      );
      expect(value).toBe(1713182400);
    } finally {
      vi.useRealTimers();
    }
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
