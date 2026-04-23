import { Gauge, Counter, Registry } from "prom-client";
import {
  BLOCK_EXPLORER_BASE_URLS,
  CHAIN_NAMES,
  POOL_PAIR_LABELS,
  blockExplorerUrl,
  chainName,
  pairLabel,
  poolAddress,
  shortAddress,
} from "./config.js";
import type { PoolRow } from "./types.js";

// Pools we've already warned about — prevents log spam on the 30s poll loop.
const warnedUnknownPools = new Set<string>();

// Logs a one-shot warning if any of the display-label maps is missing an
// entry for this pool. Silent fallbacks (`pairLabel` → pool_id, `chainName`
// → String(chainId), `blockExplorerUrl` → "") would otherwise reproduce
// the exact bug that motivated PR #209 — a new deploy that never makes it
// into config.ts ships degraded Slack alerts indefinitely. See BACKLOG.md
// entry "Shared pool + chain metadata helper" for the long-term fix.
function warnIfUnknown(pool: PoolRow): void {
  if (warnedUnknownPools.has(pool.id)) return;
  const missing: string[] = [];
  if (!(pool.id in POOL_PAIR_LABELS)) missing.push("pair");
  if (!(pool.chainId in CHAIN_NAMES)) missing.push("chain_name");
  if (!(pool.chainId in BLOCK_EXPLORER_BASE_URLS))
    missing.push("block_explorer_url");
  if (missing.length === 0) return;
  warnedUnknownPools.add(pool.id);
  console.warn(
    `[metrics-bridge] pool ${pool.id} (chain ${pool.chainId}) missing ${missing.join(", ")} — falling back. Update metrics-bridge/src/config.ts.`,
  );
}

export function healthStatusToNumber(status: string): number {
  switch (status) {
    case "OK":
      return 0;
    case "WARN":
      return 1;
    case "CRITICAL":
      return 2;
    default:
      return 3;
  }
}

const fp = (s: string) => parseFloat(s);

export const register = new Registry();

// Display-oriented labels are carried on every pool-scoped series so Slack
// alert templates can render a readable title + deep-links to the block
// explorer and dashboard without needing a PromQL join against an info metric.
// Cardinality is bounded by the number of pools (each label is 1:1 with
// pool_id), so adding them doesn't create new series — only widens them.
const poolLabels = [
  "pool_id",
  "chain_id",
  "chain_name",
  "pair",
  "pool_address_short",
  "block_explorer_url",
] as const;
const pressureLabels = [...poolLabels, "token_index"] as const;

export const gauges = {
  oracleOk: new Gauge({
    name: "mento_pool_oracle_ok",
    help: "Oracle can-trade flag at last on-chain event (1=ok, 0=not ok). For live staleness, use (time() - oracle_timestamp) / oracle_expiry in PromQL.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleTimestamp: new Gauge({
    name: "mento_pool_oracle_timestamp",
    help: "Unix timestamp of the last oracle report. Use with oracle_expiry to compute live liveness ratio.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleExpiry: new Gauge({
    name: "mento_pool_oracle_expiry",
    help: "Oracle report expiry window in seconds",
    labelNames: poolLabels,
    registers: [register],
  }),
  deviationRatio: new Gauge({
    name: "mento_pool_deviation_ratio",
    help: "Deviation ratio (priceDifference / rebalanceThreshold)",
    labelNames: poolLabels,
    registers: [register],
  }),
  deviationBreachStart: new Gauge({
    name: "mento_pool_deviation_breach_start",
    help: "Unix timestamp when deviation breach started (0 = no breach)",
    labelNames: poolLabels,
    registers: [register],
  }),
  limitPressure: new Gauge({
    name: "mento_pool_limit_pressure",
    help: "Trading limit pressure per token direction",
    labelNames: pressureLabels,
    registers: [register],
  }),
  lastRebalancedAt: new Gauge({
    name: "mento_pool_last_rebalanced_at",
    help: "Unix timestamp of the last rebalance",
    labelNames: poolLabels,
    registers: [register],
  }),
  rebalanceEffectiveness: new Gauge({
    name: "mento_pool_rebalance_effectiveness",
    help: "Last observed rebalance effectiveness ratio ((priceDiff_before - priceDiff_after) / priceDiff_before). 1.0 = fully corrected, 0 = no reduction, <0 = worse. -1 indexer sentinel is skipped.",
    labelNames: poolLabels,
    registers: [register],
  }),
  healthStatus: new Gauge({
    name: "mento_pool_health_status",
    help: "Pool health status at last on-chain event (0=OK, 1=WARN, 2=CRITICAL, 3=N/A). Event-time snapshot, not live.",
    labelNames: poolLabels,
    registers: [register],
  }),
  bridgeLastPoll: new Gauge({
    name: "mento_pool_bridge_last_poll",
    help: "Unix timestamp of the last successful poll",
    registers: [register],
  }),
};

export const counters = {
  pollErrors: new Counter({
    name: "mento_pool_bridge_poll_errors_total",
    help: "Total number of poll errors",
    registers: [register],
  }),
};

export function updateMetrics(pools: PoolRow[]): void {
  // Reset pool-level gauges to evict stale label sets from removed pools
  for (const g of Object.values(gauges)) {
    if (g !== gauges.bridgeLastPoll) g.reset();
  }

  for (const pool of pools) {
    warnIfUnknown(pool);
    const address = poolAddress(pool.id);
    const labels = {
      pool_id: pool.id,
      chain_id: String(pool.chainId),
      chain_name: chainName(pool.chainId),
      pair: pairLabel(pool.id),
      pool_address_short: shortAddress(address),
      block_explorer_url: blockExplorerUrl(pool.chainId, address),
    };

    gauges.healthStatus.set(labels, healthStatusToNumber(pool.healthStatus));
    gauges.oracleOk.set(labels, pool.oracleOk ? 1 : 0);
    gauges.oracleTimestamp.set(labels, Number(pool.oracleTimestamp));
    gauges.oracleExpiry.set(labels, Number(pool.oracleExpiry));
    // Skip the "-1" no-data sentinel. The indexer writes "-1" both on initial
    // pool creation AND during no-data intervals (rebalanceThreshold <= 0),
    // even after hasHealthData has been set to true.
    const devRatio = fp(pool.lastDeviationRatio);
    if (devRatio >= 0) {
      gauges.deviationRatio.set(labels, devRatio);
    }
    gauges.deviationBreachStart.set(
      labels,
      Number(pool.deviationBreachStartedAt),
    );
    gauges.lastRebalancedAt.set(labels, Number(pool.lastRebalancedAt));
    // Skip the "-1" no-data sentinel that the indexer writes until the first
    // RebalanceEvent for a pool. Same convention as lastDeviationRatio.
    const effRatio = fp(pool.lastEffectivenessRatio);
    if (effRatio >= 0) {
      gauges.rebalanceEffectiveness.set(labels, effRatio);
    }
    gauges.limitPressure.set(
      { ...labels, token_index: "0" },
      fp(pool.limitPressure0),
    );
    gauges.limitPressure.set(
      { ...labels, token_index: "1" },
      fp(pool.limitPressure1),
    );
  }
}
