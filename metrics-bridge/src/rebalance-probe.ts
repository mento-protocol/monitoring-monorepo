/**
 * Rebalance-reason probe runner.
 *
 * For every pool currently in critical breach (deviation > 1.05x AND
 * `deviationBreachStartedAt > 0`), simulate `rebalance(pool)` against the
 * pool's liquidity strategy and emit a `mento_pool_rebalance_blocked`
 * gauge with the decoded reason on each `(reason_code, reason_message)`
 * pair. The Slack alert template cross-references this gauge's labels via
 * `$values.B.Labels.reason_message` (Grafana's `$labels` exposes only the
 * firing query's labels, so the annotation reads query B's labels through
 * the `$values` map) to annotate the existing `Deviation Breach Critical`
 * alert.
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

// Module-scope re-entrancy guard. The production poller awaits each
// `runRebalanceProbes()` call before scheduling the next loop, so cycles can't
// overlap today — but if a future caller invokes the runner from a parallel
// timer (or if AbortController fast-cancel semantics reorder completion),
// concurrent cycles would race against the gauge reset at the top of the body
// and create zombie label sets. Skip-on-busy preserves the in-flight cycle
// rather than queueing — the next poll will probe again anyway.
let probeInProgress = false;

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

  // chainId is forwarded so the probe can resolve token symbols via
  // `@mento-protocol/monitoring-config/tokens` during reserve enrichment.
  const probe = probeRebalance(
    client,
    poolAddress,
    strategyAddress,
    pool.chainId,
  );
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
 *
 * Exported for unit testing (the runner config defaults to 5, so we can't
 * exercise lower concurrency caps via `runRebalanceProbes` without
 * monkey-patching the config module).
 */
export async function runWithConcurrency<T, R>(
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
 *   - `skip` (strategy type couldn't be identified) emits nothing and logs
 *     once — better than a misleading "blocked" annotation.
 */
export async function runRebalanceProbes(allPools: PoolRow[]): Promise<void> {
  // Re-entrancy guard: if a previous cycle is still running, drop this one.
  // The `finally` below ensures we always release the flag — including on
  // probe throws — so a transient error can't permanently disable the probe.
  if (probeInProgress) {
    console.warn(
      "[REBALANCE_PROBE_REENTRY] cycle skipped — previous cycle still running",
    );
    return;
  }
  probeInProgress = true;
  try {
    // Reset every cycle so a recovered pool (deviation dropped below
    // threshold, or the rebalancer caught up) drops out of all three
    // series immediately rather than carrying stale labels forward.
    gauges.rebalanceBlocked.reset();
    gauges.rebalanceCollateralBalance.reset();
    gauges.rebalanceCollateralNeeded.reset();
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
        const poolLabels = poolDisplayLabels(pool);
        const labels = {
          ...poolLabels,
          reason_code: result.reasonCode,
          reason_message: result.reasonMessage,
        };
        gauges.rebalanceBlocked.set(labels, 1);
        // Skipping when `reserveCollateral` is undefined (non-reserve
        // strategy, failed enrichment) lets the alert annotation fall
        // back to the bounded reason_message line cleanly.
        if (result.reserveCollateral) {
          const collateralLabels = {
            ...poolLabels,
            token_symbol: result.reserveCollateral.tokenSymbol,
          };
          gauges.rebalanceCollateralBalance.set(
            collateralLabels,
            result.reserveCollateral.balance,
          );
          gauges.rebalanceCollateralNeeded.set(
            collateralLabels,
            result.reserveCollateral.needed,
          );
        }
        // Surface the unbounded diagnostic detail (raw revert string, panic
        // code, unrecognised hex selector) to Cloud Run logs only — the
        // metric label is intentionally bounded to the ERROR_MESSAGES enum
        // for cardinality + Slack-injection-safety reasons (see
        // `rebalance-check.ts:decodeBlockedRevert`).
        if (result.diagnostic) {
          console.warn(
            `[REBALANCE_PROBE_DIAGNOSTIC] pool=${pool.id} chainId=${pool.chainId} strategy=${pool.rebalancerAddress} reason_code=${result.reasonCode} detail=${result.diagnostic}`,
          );
        }
      } else if (result.kind === "transport_error") {
        console.warn(
          `[REBALANCE_PROBE_FAILED] pool=${pool.id} chainId=${pool.chainId} strategy=${pool.rebalancerAddress} error=${result.error}`,
        );
      } else if (result.kind === "skip") {
        console.warn(
          `[REBALANCE_PROBE_SKIPPED] pool=${pool.id} chainId=${pool.chainId} strategy=${pool.rebalancerAddress} reason=${result.reason}`,
        );
      }
      // `ok` — pool can rebalance, leave the metric absent for this label set.
    }

    gauges.rebalanceProbeLastRun.set(Math.floor(Date.now() / 1000));
  } finally {
    probeInProgress = false;
  }
}
