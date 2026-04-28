import { fetchPools } from "./graphql.js";
import { gauges, counters, updateMetrics } from "./metrics.js";
import { runRebalanceProbes } from "./rebalance-probe.js";
import { markHealthy } from "./server.js";
import { POLL_INTERVAL_MS, REBALANCE_PROBE_EVERY_N_POLLS } from "./config.js";
import type { PoolRow } from "./types.js";

// Cycle counter — incremented on every successful Hasura poll. The rebalance
// probe runs when `(pollCycle % REBALANCE_PROBE_EVERY_N_POLLS) === 1` so the
// FIRST poll after startup already runs a probe (otherwise an operator
// restarting the bridge mid-breach would wait up to N polls for the
// reason annotation). Failed Hasura polls don't advance the counter.
let pollCycle = 0;

/** @internal Test-only: reset the pollCycle counter. */
export function _resetPollCycleForTests(): void {
  pollCycle = 0;
}

async function maybeRunRebalanceProbe(pools: PoolRow[]): Promise<void> {
  if (pollCycle % REBALANCE_PROBE_EVERY_N_POLLS !== 1) return;
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
    pollCycle += 1;
    await maybeRunRebalanceProbe(data.Pool);
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
