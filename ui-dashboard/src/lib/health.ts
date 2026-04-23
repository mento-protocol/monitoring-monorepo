/**
 * Health status computation for pool oracle monitoring.
 * Mirrors the logic in the indexer's EventHandlers.ts.
 */

export type HealthStatus = "OK" | "WARN" | "WEEKEND" | "CRITICAL" | "N/A";

import { isWeekend, tradingSecondsInRange } from "./weekend";

/**
 * Fallback oracle staleness threshold in seconds.
 *
 * Used when oracleExpiry is not yet indexed for a pool (e.g. pools created
 * before the indexer started capturing it). SortedOracles.reportExpirySeconds()
 * on Celo mainnet = 300s (5 min), which is the lowest value across supported chains.
 */
const ORACLE_STALE_SECONDS = 300;

/**
 * Per-chain fallback for SortedOracles.reportExpirySeconds().
 *
 * Values fetched on-chain 2025-03-14:
 *   - Celo mainnet  (42220): 300s  (0x12c)
 *   - Monad mainnet (143):   360s  (0x168)
 *
 * Used when oracleExpiry is 0 in the DB (pool created before the indexer
 * started fetching it, or first-seen on a chain that returned null).
 * Falls back to ORACLE_STALE_SECONDS (300) for unknown chains.
 */
export const ORACLE_STALE_SECONDS_BY_CHAIN: Record<number, number> = {
  42220: 300, // Celo mainnet
  11142220: 300, // Celo Alfajores
  143: 360, // Monad mainnet
  10143: 360, // Monad testnet
};

interface PoolHealthState {
  source?: string;
  oracleOk?: boolean;
  oracleTimestamp?: string;
  oracleExpiry?: string;
  priceDifference?: string;
  rebalanceThreshold?: number;
  lastRebalancedAt?: string | null;
  deviationBreachStartedAt?: string | null;
}

/**
 * How long a pool may sit above the rebalance threshold before it escalates
 * from WARN to CRITICAL. Below the threshold is always OK; a fresh breach is
 * WARN for up to this window, then CRITICAL.
 *
 * Anchored on `deviationBreachStartedAt` (indexed at the block the pool first
 * crossed the threshold). If that field is missing — rare, only when the
 * indexer hasn't populated it yet — we stay at WARN rather than spuriously
 * escalating.
 */
export const DEVIATION_BREACH_GRACE_SECONDS = 3600;

export function getOracleStalenessThreshold(
  pool: { oracleExpiry?: string },
  chainId?: number,
): number {
  const indexed = Number(pool.oracleExpiry ?? "0");
  if (indexed > 0) return indexed;
  return (
    (chainId !== undefined
      ? ORACLE_STALE_SECONDS_BY_CHAIN[chainId]
      : undefined) ?? ORACLE_STALE_SECONDS
  );
}

export function isOracleFresh(
  pool: {
    oracleTimestamp?: string;
    oracleExpiry?: string;
  },
  nowSeconds = Math.floor(Date.now() / 1000),
  chainId?: number,
): boolean {
  const oracleTs = Number(pool.oracleTimestamp ?? "0");
  const stalenessThreshold = getOracleStalenessThreshold(pool, chainId);
  return oracleTs !== 0 && nowSeconds - oracleTs <= stalenessThreshold;
}

/**
 * Compute the health status for a pool based on its oracle state.
 *
 * - "N/A":       VirtualPools (source includes "virtual") — no oracle
 * - "CRITICAL":  Oracle is stale (age > expiry), OR deviation > threshold
 *                for more than DEVIATION_BREACH_GRACE_SECONDS
 * - "WEEKEND":   Oracle is stale because FX markets are closed (Fri 21:00 – Sun 23:00 UTC)
 * - "WARN":      Oracle is fresh and deviation > threshold but still within
 *                the grace window
 * - "OK":        Oracle is fresh and deviation is at or below threshold
 *
 * Being close to but still under the threshold is OK — there's nothing
 * actionable in that state. The pool only flips to WARN when it actually
 * breaches, giving operators a 1h window to land a rebalance before
 * escalating to CRITICAL.
 *
 * Uses wall-clock time comparison rather than the indexed oracleOk flag,
 * which is only set at event time and never expires. The staleness threshold
 * comes from the indexed oracleExpiry (fetched per-feed from SortedOracles
 * at index time), falling back to ORACLE_STALE_SECONDS for pools that
 * pre-date this field.
 */
export function computeHealthStatus(
  pool: PoolHealthState,
  chainId?: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): HealthStatus {
  if (pool.source?.includes("virtual")) return "N/A";
  const isOracleStale = !isOracleFresh(pool, nowSeconds, chainId);
  if (isOracleStale) {
    // Distinguish expected weekend staleness from a real incident
    if (isWeekend()) return "WEEKEND";
    return "CRITICAL";
  }
  const diff = Number(pool.priceDifference ?? "0");
  const threshold =
    (pool.rebalanceThreshold ?? 0) > 0 ? pool.rebalanceThreshold! : 10000;
  const devRatio = diff / threshold;
  if (devRatio > 1.0) {
    const breachStart = Number(pool.deviationBreachStartedAt ?? "0");
    // No anchor (indexer hasn't populated the field yet): treat as a fresh
    // breach and stay at WARN instead of jumping to CRITICAL without data.
    if (breachStart <= 0) return "WARN";
    const breachAge = nowSeconds - breachStart;
    return breachAge < DEVIATION_BREACH_GRACE_SECONDS ? "WARN" : "CRITICAL";
  }
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

/** Tailwind bg-color class for a trading-limit pressure ratio (1.0 = limit breached). */
export function pressureColorClass(pressure: number): string {
  if (pressure >= 1.0) return "bg-red-500";
  if (pressure >= 0.8) return "bg-amber-500";
  return "bg-emerald-500";
}

/**
 * Tailwind text-color class for an uptime percentage (0–100). Tier
 * thresholds are intentionally coarse — we want "red = page someone"
 * not "red = SLO budget touched". Adjust upward once breach attribution
 * is solid and we have a real three-nines target.
 *
 *   >99%   → emerald
 *   90-99% → yellow
 *   70-90% → amber
 *   <70%   → red
 */
export function uptimeColorClass(pct: number): string {
  if (!Number.isFinite(pct)) return "text-slate-500";
  if (pct > 99) return "text-emerald-400";
  if (pct >= 90) return "text-yellow-400";
  if (pct >= 70) return "text-amber-400";
  return "text-red-400";
}

/**
 * All-time uptime % for a pool, computed from the indexer rollup
 * counters. Returns `null` when we don't have enough data to answer
 * honestly (virtual pool, rollup not populated yet during reindex,
 * zero observation window). Keep the math aligned with the
 * UptimeValue tile — both callers read the SAME snapshot so the
 * homepage column and the pool page never disagree.
 *
 * Includes the live past-grace portion of an in-flight open breach so
 * the number matches the pool page's tile. An open breach can tank a
 * pool's all-time % by tens of points (rolledCritical only counts
 * CLOSED breaches), and excluding it on the homepage made "EURm/USDm
 * 100%" render next to "1 ongoing breach · 4.241%" on the pool page.
 */
export function computePoolUptimePct(pool: {
  source: string;
  healthTotalSeconds?: string;
  cumulativeCriticalSeconds?: string;
  deviationBreachStartedAt?: string;
}): number | null {
  if (pool.source.includes("virtual")) return null;
  const total = Number(pool.healthTotalSeconds ?? "0");
  if (!Number.isFinite(total) || total <= 0) return null;
  if (pool.cumulativeCriticalSeconds == null) return null;
  const rolledCritical = Number(pool.cumulativeCriticalSeconds);
  if (!Number.isFinite(rolledCritical)) return null;

  // Open-breach live past-grace credit — same math as the tile.
  // `tradingSecondsInRange` subtracts FX-weekend hours so the numerator
  // stays on the same basis as `healthTotalSeconds` (the denominator).
  const openStart = Number(pool.deviationBreachStartedAt ?? "0");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const graceEnd = openStart + Number(DEVIATION_BREACH_GRACE_SECONDS);
  const openCritical =
    openStart > 0 && nowSeconds > graceEnd
      ? tradingSecondsInRange(graceEnd, nowSeconds)
      : 0;

  const critical = rolledCritical + openCritical;
  return Math.max(0, Math.min(100, (1 - critical / total) * 100));
}

/**
 * Severity rank used to pick the worst status across oracle health and limit health.
 * N/A is least severe; CRITICAL is most severe.
 */
const STATUS_RANK: Record<string, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  WEEKEND: 3,
  CRITICAL: 4,
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
export function computeEffectiveStatus(
  pool: {
    source?: string;
    oracleOk?: boolean;
    oracleTimestamp?: string;
    oracleExpiry?: string;
    priceDifference?: string;
    rebalanceThreshold?: number;
    deviationBreachStartedAt?: string | null;
    lastRebalancedAt?: string | null;
    limitStatus?: string;
    limitPressure0?: string;
    limitPressure1?: string;
  },
  chainId?: number,
): HealthStatus {
  const health = computeHealthStatus(pool, chainId);
  const limit: string = pool.limitStatus ?? computeLimitStatus(pool);
  return worstStatus(health, limit);
}

type RebalancerStatus = "ACTIVE" | "STALE" | "N/A" | "NO_DATA";

/**
 * Compute rebalancer liveness for a pool.
 *
 * - "N/A":     VirtualPools — rebalancer not applicable by design
 * - "NO_DATA": FPMM pool with no rebalance events recorded yet
 * - "STALE":   age > 86400s AND pool is currently breached (deviation above
 *              threshold) — a rebalancer that hasn't fired in 24h while the
 *              pool is out of range is the actual concern
 * - "ACTIVE":  within 24h OR pool is under threshold (no work to do,
 *              silence is expected)
 */
export function computeRebalancerLiveness(
  pool: {
    source?: string;
    lastRebalancedAt?: string;
    priceDifference?: string;
    rebalanceThreshold?: number;
  },
  nowSeconds: number,
): RebalancerStatus {
  if (pool.source?.includes("virtual")) return "N/A";
  if (!pool.lastRebalancedAt || pool.lastRebalancedAt === "0") return "NO_DATA";
  const age = nowSeconds - Number(pool.lastRebalancedAt);
  if (age <= 86400) return "ACTIVE";
  const diff = Number(pool.priceDifference ?? "0");
  const threshold =
    (pool.rebalanceThreshold ?? 0) > 0 ? pool.rebalanceThreshold! : 10000;
  // A rebalancer that hasn't fired in 24h is only actually stale if the
  // pool needs rebalancing. Under-threshold means there's nothing to do,
  // so absence of activity is expected.
  const needsRebalance = diff > threshold;
  return needsRebalance ? "STALE" : "ACTIVE";
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
