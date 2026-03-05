/**
 * Health status computation for pool oracle monitoring.
 * Mirrors the logic in the indexer's EventHandlers.ts.
 */

export type HealthStatus = "OK" | "WARN" | "CRITICAL" | "N/A";

export interface PoolHealthState {
  source?: string;
  oracleOk?: boolean;
  priceDifference?: string;
  rebalanceThreshold?: number;
}

/**
 * Compute the health status for a pool based on its oracle state.
 *
 * - "N/A":       VirtualPools (source includes "virtual") — no oracle
 * - "CRITICAL":  Oracle is stale (oracleOk == false) OR deviation >= threshold
 * - "WARN":      Oracle is fresh but deviation >= 80% of threshold
 * - "OK":        Oracle is fresh and deviation is below 80% of threshold
 */
export function computeHealthStatus(pool: PoolHealthState): HealthStatus {
  if (pool.source?.includes("virtual")) return "N/A";
  if (!pool.oracleOk) return "CRITICAL";
  const diff = Number(pool.priceDifference ?? "0");
  const threshold =
    (pool.rebalanceThreshold ?? 0) > 0 ? pool.rebalanceThreshold! : 10000;
  const devRatio = diff / threshold;
  if (devRatio >= 1.0) return "CRITICAL";
  if (devRatio >= 0.8) return "WARN";
  return "OK";
}

/**
 * Compute the trading limit status for a pool based on pressure values.
 *
 * - "N/A":       VirtualPools (source includes "virtual") — no limits
 * - "CRITICAL":  max pressure >= 1.0 (limit breached)
 * - "WARN":      max pressure >= 0.8
 * - "OK":        max pressure < 0.8
 */
export function computeLimitStatus(pool: {
  source?: string;
  limitPressure0?: string;
  limitPressure1?: string;
}): HealthStatus {
  if (pool.source?.includes("virtual")) return "N/A";
  const p0 = Number(pool.limitPressure0 ?? "0");
  const p1 = Number(pool.limitPressure1 ?? "0");
  const max = Math.max(p0, p1);
  if (max >= 1.0) return "CRITICAL";
  if (max >= 0.8) return "WARN";
  return "OK";
}

export type RebalancerStatus = "ACTIVE" | "STALE" | "N/A";

/**
 * Compute rebalancer liveness for a pool.
 *
 * - "N/A":    VirtualPools or no rebalance data
 * - "STALE":  age > 86400s AND healthStatus !== "OK"
 * - "ACTIVE": within 24h OR healthStatus is "OK"
 */
export function computeRebalancerLiveness(
  pool: {
    source?: string;
    lastRebalancedAt?: string;
    healthStatus?: string;
  },
  nowSeconds: number,
): RebalancerStatus {
  if (pool.source?.includes("virtual")) return "N/A";
  if (!pool.lastRebalancedAt || pool.lastRebalancedAt === "0") return "N/A";
  const age = nowSeconds - Number(pool.lastRebalancedAt);
  const isStale = age > 86400 && pool.healthStatus !== "OK";
  return isStale ? "STALE" : "ACTIVE";
}

/**
 * Format deviation as a percentage of the threshold.
 * Returns a string like "49.1%" or "0%".
 */
export function formatDeviationPct(
  priceDifference: string,
  rebalanceThreshold: number,
): string {
  if (!rebalanceThreshold || rebalanceThreshold === 0) return "0%";
  const ratio = Number(priceDifference) / rebalanceThreshold;
  return `${(ratio * 100).toFixed(1)}%`;
}
