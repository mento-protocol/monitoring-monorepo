import {
  computeHealthStatus,
  effectiveThreshold,
  isNeverRebalance,
  resolveLimitStatus,
  worstStatus,
  type HealthStatus,
} from "@/lib/health";
import { poolName } from "@/lib/tokens";
import { isVirtualPool } from "@/lib/types";
import type { GlobalPoolEntry } from "@/components/global-pools-table/sort";

export type ProtocolStatusLevel = "ok" | "warning" | "critical" | "empty";

type WorstDeviation = {
  deviationBps: number;
  thresholdRatio: number;
  poolLabel: string;
  networkLabel: string;
};

export type ProtocolStatusSummary = {
  totalPools: number;
  criticalCount: number;
  haltedCount: number;
  warnCount: number;
  weekendCount: number;
  nonVirtualDataGapCount: number;
  failedNetworkCount: number;
  rebalanceInFlightCount: number;
  limitAttentionCount: number;
  worstDeviation: WorstDeviation | null;
  level: ProtocolStatusLevel;
};

export function summarizeProtocolStatus({
  entries,
  failedNetworkCount,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  entries: GlobalPoolEntry[];
  failedNetworkCount: number;
  nowSeconds?: number;
}): ProtocolStatusSummary {
  const summary: Omit<ProtocolStatusSummary, "level"> = {
    totalPools: entries.length,
    criticalCount: 0,
    haltedCount: 0,
    warnCount: 0,
    weekendCount: 0,
    nonVirtualDataGapCount: 0,
    failedNetworkCount,
    rebalanceInFlightCount: 0,
    limitAttentionCount: 0,
    worstDeviation: null,
  };

  for (const entry of entries) {
    const health = computeHealthStatus(
      entry.pool,
      entry.network.chainId,
      nowSeconds,
    );
    const limit = resolveLimitStatus(entry.pool);
    const effective =
      health === "N/A" && (limit === "OK" || limit === "N/A")
        ? "N/A"
        : worstStatus(health, limit);
    countEffectiveStatus(summary, effective, entry.pool);

    if (health === "WARN") summary.rebalanceInFlightCount += 1;

    if (limit === "WARN" || limit === "CRITICAL") {
      summary.limitAttentionCount += 1;
    }

    const deviation = poolDeviation(entry);
    if (
      deviation &&
      (!summary.worstDeviation ||
        deviation.thresholdRatio > summary.worstDeviation.thresholdRatio)
    ) {
      summary.worstDeviation = deviation;
    }
  }

  return { ...summary, level: protocolStatusLevel(summary) };
}

function countEffectiveStatus(
  summary: Omit<ProtocolStatusSummary, "level">,
  status: HealthStatus,
  pool: GlobalPoolEntry["pool"],
): void {
  switch (status) {
    case "CRITICAL":
      summary.criticalCount += 1;
      break;
    case "HALTED":
      summary.haltedCount += 1;
      break;
    case "WARN":
      summary.warnCount += 1;
      break;
    case "WEEKEND":
      summary.weekendCount += 1;
      break;
    case "N/A":
      if (!isVirtualPool(pool)) summary.nonVirtualDataGapCount += 1;
      break;
    case "OK":
      break;
  }
}

function poolDeviation(entry: GlobalPoolEntry): WorstDeviation | null {
  if (isVirtualPool(entry.pool) || isNeverRebalance(entry.pool)) return null;
  const deviationBps = Math.abs(Number(entry.pool.priceDifference ?? "0"));
  const threshold = effectiveThreshold(entry.pool);
  if (
    !Number.isFinite(deviationBps) ||
    !Number.isFinite(threshold) ||
    deviationBps <= 0 ||
    threshold <= 0
  ) {
    return null;
  }

  return {
    deviationBps,
    thresholdRatio: deviationBps / threshold,
    poolLabel: poolName(entry.network, entry.pool.token0, entry.pool.token1),
    networkLabel: entry.network.label,
  };
}

function protocolStatusLevel(
  summary: Omit<ProtocolStatusSummary, "level">,
): ProtocolStatusLevel {
  if (summary.totalPools === 0 && summary.failedNetworkCount === 0) {
    return "empty";
  }
  if (summary.criticalCount > 0 || summary.haltedCount > 0) {
    return "critical";
  }
  if (
    summary.warnCount > 0 ||
    summary.failedNetworkCount > 0 ||
    summary.nonVirtualDataGapCount > 0
  ) {
    return "warning";
  }
  return "ok";
}
