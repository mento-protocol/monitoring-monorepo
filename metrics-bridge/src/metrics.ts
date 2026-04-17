import { Gauge, Counter, Registry } from "prom-client";
import { pairLabel } from "./config.js";
import type { PoolRow } from "./types.js";

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

const poolLabels = ["pool_id", "chain_id", "pair"] as const;
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
    const labels = {
      pool_id: pool.id,
      chain_id: String(pool.chainId),
      pair: pairLabel(pool.id),
    };

    gauges.healthStatus.set(labels, healthStatusToNumber(pool.healthStatus));
    gauges.oracleOk.set(labels, pool.oracleOk ? 1 : 0);
    gauges.oracleTimestamp.set(labels, Number(pool.oracleTimestamp));
    gauges.oracleExpiry.set(labels, Number(pool.oracleExpiry));
    gauges.deviationRatio.set(labels, fp(pool.lastDeviationRatio));
    gauges.deviationBreachStart.set(
      labels,
      Number(pool.deviationBreachStartedAt),
    );
    gauges.lastRebalancedAt.set(labels, Number(pool.lastRebalancedAt));
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
