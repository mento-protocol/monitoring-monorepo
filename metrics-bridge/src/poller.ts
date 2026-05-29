import { fetchPools } from "./graphql.js";
import {
  gauges,
  counters,
  updateMetrics,
  type PollErrorKind,
} from "./metrics.js";
import { runRebalanceProbes } from "./rebalance-probe.js";
import { markHealthy } from "./server.js";
import { POLL_INTERVAL_MS, REBALANCE_PROBE_EVERY_N_POLLS } from "./config.js";
import type { PoolRow } from "./types.js";

// Cycle counter — 0-indexed, advanced AFTER each probe check on successful
// Hasura polls. The rebalance probe runs when
// `(pollCycle % REBALANCE_PROBE_EVERY_N_POLLS) === 0`, so cycle 0 (the first
// successful poll after startup) ALWAYS fires the probe — otherwise an
// operator restarting the bridge mid-breach would wait up to N polls for
// the reason annotation. Failed Hasura polls don't advance the counter so
// the probe still attaches to the next SUCCESSFUL cycle.
//
// `=== 0` (rather than the previous `=== 1`) is the load-bearing change:
// `pollCycle % 1` is always 0, so `=== 1` silently disabled the probe
// entirely whenever an operator set `REBALANCE_PROBE_EVERY_N_POLLS=1`
// intending "probe every poll". The 0-indexed predicate is well-defined
// for all N >= 1.
let pollCycle = 0;

/** @internal Test-only: reset the pollCycle counter. */
export function _resetPollCycleForTests(): void {
  pollCycle = 0;
}

function recordPollError(
  kind: PollErrorKind,
  message: string,
  error: unknown,
): void {
  counters.pollErrors.inc({ kind });
  console.error(message, error);
}

async function maybeRunRebalanceProbe(pools: PoolRow[]): Promise<void> {
  if (pollCycle % REBALANCE_PROBE_EVERY_N_POLLS !== 0) return;
  try {
    await runRebalanceProbes(pools);
  } catch (error) {
    // Probe failures must not derail the metrics-bridge — alerts keep firing
    // on the underlying breach gauge. Log once and move on.
    recordPollError("rebalance_probe", "Rebalance probe failed:", error);
  }
}

export async function poll(): Promise<void> {
  let pools: PoolRow[];
  try {
    const data = await fetchPools();
    pools = data.Pool;
  } catch (error) {
    recordPollError(
      "hasura_query",
      "Poll failed while querying Hasura:",
      error,
    );
    return;
  }

  try {
    updateMetrics(pools);
  } catch (error) {
    recordPollError(
      "update_metrics",
      "Poll failed while updating metrics:",
      error,
    );
    return;
  }

  gauges.bridgeLastPoll.set(Math.floor(Date.now() / 1000));

  try {
    markHealthy();
  } catch (error) {
    recordPollError(
      "mark_healthy",
      "Poll failed while marking healthy:",
      error,
    );
    return;
  }

  await maybeRunRebalanceProbe(pools);
  // Increment AFTER the probe check so cycle 0 (cold start) fires the
  // probe. A failed Hasura poll leaves the counter unchanged so the probe
  // attaches to the next successful cycle. Probe failures are recorded but do
  // not derail the poll, preserving the prior "alerts keep firing" behavior.
  pollCycle += 1;
}

async function loop(): Promise<void> {
  await poll();
  // `setTimeout` expects a void-returning callback; passing `loop` directly
  // discards the returned Promise and any rejection bubbles up as
  // `unhandledRejection`. Wrap in a `void`-discarding closure so the
  // intentional fire-and-forget is explicit.
  setTimeout(() => void loop(), POLL_INTERVAL_MS);
}

export function startPolling(): void {
  // Same fire-and-forget pattern: `loop()` runs forever; if it ever rejects,
  // each `poll()` call already swallows its own errors, so the only way out
  // is a programmer error here. `void` makes the discard explicit for the
  // `no-floating-promises` lint.
  void loop();
}
