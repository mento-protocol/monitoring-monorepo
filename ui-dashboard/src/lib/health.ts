/**
 * Health status computation for pool oracle monitoring.
 * Mirrors the logic in the indexer's EventHandlers.ts.
 */

export type HealthStatus = "OK" | "WARN" | "CRITICAL" | "N/A";

/**
 * Fallback oracle staleness threshold in seconds.
 *
 * Used when oracleExpiry is not yet indexed for a pool (e.g. pools created
 * before the indexer started capturing it). SortedOracles.reportExpirySeconds()
 * on Celo mainnet = 300s (5 min), which is the lowest value across supported chains.
 */
export const ORACLE_STALE_SECONDS = 300;

export interface PoolHealthState {
  source?: string;
  oracleOk?: boolean;
  oracleTimestamp?: string;
  oracleExpiry?: string;
  priceDifference?: string;
  rebalanceThreshold?: number;
}

/**
 * Compute the health status for a pool based on its oracle state.
 *
 * - "N/A":       VirtualPools (source includes "virtual") — no oracle
 * - "CRITICAL":  Oracle is stale (age > expiry) OR deviation >= threshold
 * - "WARN":      Oracle is fresh but deviation >= 80% of threshold
 * - "OK":        Oracle is fresh and deviation is below 80% of threshold
 *
 * Uses wall-clock time comparison rather than the indexed oracleOk flag,
 * which is only set at event time and never expires.
 *
 * The staleness threshold comes from the indexed oracleExpiry (fetched
 * per-feed from SortedOracles at index time), falling back to ORACLE_STALE_SECONDS
 * for pools that pre-date this field.
 */
export function computeHealthStatus(pool: PoolHealthState): HealthStatus {
  if (pool.source?.includes("virtual")) return "N/A";
  // Time-based staleness check (client-side wall clock)
  const oracleTs = Number(pool.oracleTimestamp ?? "0");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stalenessThreshold =
    Number(pool.oracleExpiry ?? "0") || ORACLE_STALE_SECONDS;
  const isOracleStale =
    oracleTs === 0 || nowSeconds - oracleTs > stalenessThreshold;
  if (isOracleStale) return "CRITICAL";
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

/**
 * Severity rank used to pick the worst status across oracle health and limit health.
 * N/A is least severe; CRITICAL is most severe.
 */
const STATUS_RANK: Record<string, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  CRITICAL: 3,
};

export function worstStatus(a: string, b: string): HealthStatus {
  return (
    (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b
  ) as HealthStatus;
}

/**
 * Compute the effective display status for a pool, taking the worst of
 * oracle health and trading limit status. This is what the Health badge shows.
 */
export function computeEffectiveStatus(pool: {
  source?: string;
  oracleOk?: boolean;
  oracleTimestamp?: string;
  oracleExpiry?: string;
  priceDifference?: string;
  rebalanceThreshold?: number;
  limitStatus?: string;
  limitPressure0?: string;
  limitPressure1?: string;
}): HealthStatus {
  const health = computeHealthStatus(pool);
  const limit: string = pool.limitStatus ?? computeLimitStatus(pool);
  return worstStatus(health, limit);
}

export type RebalancerStatus = "ACTIVE" | "STALE" | "N/A" | "NO_DATA";

/**
 * Compute rebalancer liveness for a pool.
 *
 * - "N/A":     VirtualPools — rebalancer not applicable by design
 * - "NO_DATA": FPMM pool with no rebalance events recorded yet
 * - "STALE":   age > 86400s AND healthStatus !== "OK"
 * - "ACTIVE":  within 24h OR healthStatus is "OK"
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
  if (!pool.lastRebalancedAt || pool.lastRebalancedAt === "0") return "NO_DATA";
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
