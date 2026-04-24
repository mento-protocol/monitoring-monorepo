import { Gauge, Counter, Registry } from "prom-client";
import {
  chainSlug,
  explorerAddressUrl,
  hasChain,
} from "@mento-protocol/monitoring-config/chains";
import { poolName } from "@mento-protocol/monitoring-config/tokens";
import {
  poolIdAddress,
  shortAddress,
} from "@mento-protocol/monitoring-config/format";
import type { PoolRow } from "./types.js";

// Pools we've already warned about — prevents log spam on the 30s poll loop.
const warnedUnknownPools = new Set<string>();

// PR #209 safety net — warn once per pool when any display label falls back,
// so a missing chain/token in shared-config or @mento-protocol/contracts
// doesn't silently ship degraded Slack alerts.
function warnIfUnknown(pool: PoolRow, pair: string | null): void {
  if (warnedUnknownPools.has(pool.id)) return;
  const missing: string[] = [];
  if (pair === null) {
    // Include token addresses so on-call can jump straight to @mento-protocol/contracts
    // without looking up the pool row in Hasura first.
    missing.push(
      `pair (token0=${pool.token0 ?? "null"}, token1=${pool.token1 ?? "null"})`,
    );
  }
  if (!hasChain(pool.chainId)) missing.push("chain_name", "block_explorer_url");
  if (missing.length === 0) return;
  warnedUnknownPools.add(pool.id);
  console.warn(
    `[metrics-bridge] pool ${pool.id} (chain ${pool.chainId}) missing ${missing.join(", ")} — falling back. Add the chain to shared-config/chain-metadata.json, or the token to @mento-protocol/contracts.`,
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
    help: "Last observed rebalance effectiveness ratio: (priceDiff_before - priceDiff_after) / (priceDiff_before - rebalanceThreshold). 1.0 = rebalance landed exactly on the rebalance boundary (ideal); >1.0 = overshoot past the boundary (e.g. all the way to the oracle, which is over-correction); 0 = no reduction; <0 = rebalance made deviation WORSE. -1 indexer sentinel (degenerate case — zero pre-deviation, missing threshold, or pool was already in-band) is skipped.",
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
    const address = poolIdAddress(pool.id);
    const derivedPair = poolName(pool.chainId, pool.token0, pool.token1);
    warnIfUnknown(pool, derivedPair);
    const labels = {
      pool_id: pool.id,
      chain_id: String(pool.chainId),
      chain_name: chainSlug(pool.chainId),
      pair: derivedPair ?? pool.id,
      pool_address_short: shortAddress(address),
      block_explorer_url: explorerAddressUrl(pool.chainId, address) ?? "",
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
    // Skip only the explicit "-1" no-data sentinel the indexer writes before
    // a pool has ever rebalanced (or for degenerate rebalances with zero
    // pre-deviation). Negative non-sentinel values (rebalance moved price
    // FURTHER from oracle) are legitimate observations and MUST publish — the
    // `Rebalance Ineffective` alert explicitly treats `< 0` as worse-than-noop.
    if (pool.lastEffectivenessRatio !== "-1") {
      gauges.rebalanceEffectiveness.set(
        labels,
        fp(pool.lastEffectivenessRatio),
      );
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
