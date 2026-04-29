import { fetchPools } from "./graphql.js";
import { gauges, counters, updateMetrics } from "./metrics.js";
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
// for all N >= 1 — see BACKLOG `Rebalance probe: handle EVERY_N=1`.
let pollCycle = 0;

/** @internal Test-only: reset the pollCycle counter. */
export function _resetPollCycleForTests(): void {
  pollCycle = 0;
}

async function maybeRunRebalanceProbe(pools: PoolRow[]): Promise<void> {
  if (pollCycle % REBALANCE_PROBE_EVERY_N_POLLS !== 0) return;
  try {
    await runRebalanceProbes(pools);
  } catch (error) {
    // Probe failures must not derail the metrics-bridge — alerts keep firing
    // on the underlying breach gauge. Log once and move on.
    console.error("Rebalance probe failed:", error);
  }
}

export async function poll(): Promise<void> {
  try {
    const data = await fetchPools();
    updateMetrics(data.Pool);
    gauges.bridgeLastPoll.set(Math.floor(Date.now() / 1000));
    markHealthy();
    await maybeRunRebalanceProbe(data.Pool);
    // Increment AFTER the probe check so cycle 0 (cold start) fires the
    // probe. A failed poll throws before this line, leaving the counter
    // unchanged so the probe attaches to the next successful cycle.
    pollCycle += 1;
  } catch (error) {
    counters.pollErrors.inc();
    console.error("Poll failed:", error);
  }
}

async function loop(): Promise<void> {
  await poll();
  setTimeout(loop, POLL_INTERVAL_MS);
}

export function startPolling(): void {
  loop();
}
