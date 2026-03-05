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
