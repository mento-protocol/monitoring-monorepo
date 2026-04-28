/**
 * Rebalance-reason probe runner.
 *
 * For every pool currently in critical breach (deviation > 1.05x AND
 * `deviationBreachStartedAt > 0`), simulate `rebalance(pool)` against the
 * pool's liquidity strategy and emit a `mento_pool_rebalance_blocked`
 * gauge with the decoded reason on each `(reason_code, reason_message)`
 * pair. The Slack alert template reads `$labels.reason_message` to
 * annotate the existing `Deviation Breach Critical` alert.
 *
 * Run cadence is controlled by `REBALANCE_PROBE_EVERY_N_POLLS` — see
 * `poller.ts`. The gauge is RESET at the start of each cycle so a pool
 * that recovered between probes drops out of the metric immediately.
 */

import { poolIdAddress } from "@mento-protocol/monitoring-config/format";
import {
  REBALANCE_PROBE_CONCURRENCY,
  REBALANCE_PROBE_DEVIATION_THRESHOLD,
  REBALANCE_PROBE_TIMEOUT_MS,
} from "./config.js";
import { gauges, poolDisplayLabels } from "./metrics.js";
import {
  probeRebalance,
  type RebalanceProbeResult,
} from "./rebalance-check.js";
import { getRpcClient } from "./rpc.js";
import type { PoolRow } from "./types.js";

/**
 * Returns pools eligible for the rebalance-reason probe — same gating as the
 * `Deviation Breach Critical` rule (`terraform/alerts/rules-fpmms.tf:470`)
 * so we only annotate alerts that can actually fire.
 *
 *   - `deviationBreachStartedAt > 0` (active breach anchor)
 *   - `lastDeviationRatio > 1.05` (5% over threshold)
 *   - `rebalancerAddress` non-empty (no point probing virtual pools)
 */
export function eligibleForProbe(pools: PoolRow[]): PoolRow[] {
  return pools.filter((pool) => {
    if (Number(pool.deviationBreachStartedAt) <= 0) return false;
    const ratio = parseFloat(pool.lastDeviationRatio);
    if (!Number.isFinite(ratio)) return false;
    if (ratio <= REBALANCE_PROBE_DEVIATION_THRESHOLD) return false;
    if (!pool.rebalancerAddress) return false;
    return true;
  });
}

/**
 * Run a single probe against a pool, with a wall-clock timeout to prevent a
 * stuck RPC from blocking the next Hasura poll. Returns either the probe
 * result, a transport_error wrapping the timeout, or a transport_error
 * carrying "no rpc client" when the chain isn't configured.
 */
async function probeOne(pool: PoolRow): Promise<RebalanceProbeResult> {
  const client = getRpcClient(pool.chainId);
  if (!client) {
    return { kind: "transport_error", error: "no rpc client for chain" };
  }
  const poolAddress = poolIdAddress(pool.id) as `0x${string}`;
  const strategyAddress = pool.rebalancerAddress as `0x${string}`;

  const probe = probeRebalance(client, poolAddress, strategyAddress);
  const timeout = new Promise<RebalanceProbeResult>((resolve) => {
    setTimeout(
      () =>
        resolve({
          kind: "transport_error",
          error: `probe timed out after ${REBALANCE_PROBE_TIMEOUT_MS}ms`,
        }),
      REBALANCE_PROBE_TIMEOUT_MS,
    );
  });
  return Promise.race([probe, timeout]);
}

/**
 * Bounded-concurrency runner — caps simultaneous in-flight probes so a
 * stuck RPC endpoint can't fan out unbounded tasks against the next Hasura
 * cycle. At Mento's scale 0–3 pools are typically eligible per cycle, so
 * the concurrency cap is mostly a safety rail.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Run the probe for every eligible pool and update the
 * `mento_pool_rebalance_blocked` gauge.
 *
 *   - `ok` results emit nothing (gauge stays absent for that pool).
 *   - `blocked` results emit `1` with `(reason_code, reason_message)` labels.
 *   - `transport_error` emits nothing and logs once per pool — the
 *     underlying critical breach alert keeps firing without an annotation.
 */
export async function runRebalanceProbes(allPools: PoolRow[]): Promise<void> {
  // Reset the gauge first so a pool that recovered between probes
  // (deviation dropped below threshold, or the rebalancer caught up)
  // immediately drops out of the metric.
  gauges.rebalanceBlocked.reset();
  const eligible = eligibleForProbe(allPools);
  if (eligible.length === 0) {
    gauges.rebalanceProbeLastRun.set(Math.floor(Date.now() / 1000));
    return;
  }

  const results = await runWithConcurrency(
    eligible,
    REBALANCE_PROBE_CONCURRENCY,
    probeOne,
  );

  for (let i = 0; i < eligible.length; i++) {
    const pool = eligible[i];
    const result = results[i];
    if (!result) continue;

    if (result.kind === "blocked") {
      const labels = {
        ...poolDisplayLabels(pool),
        reason_code: result.reasonCode,
        reason_message: result.reasonMessage,
      };
      gauges.rebalanceBlocked.set(labels, 1);
    } else if (result.kind === "transport_error") {
      console.warn(
        `[REBALANCE_PROBE_FAILED] pool=${pool.id} chainId=${pool.chainId} strategy=${pool.rebalancerAddress} error=${result.error}`,
      );
    }
    // `ok` — pool can rebalance, leave the metric absent for this label set.
  }

  gauges.rebalanceProbeLastRun.set(Math.floor(Date.now() / 1000));
}
