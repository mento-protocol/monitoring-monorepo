import type { OracleSnapshot, Pool } from "@/lib/types";
import { getOracleStalenessThreshold } from "@/lib/health";

export type BinaryHealthWindow = {
  score: number | null; // 0..1, null => no data
  trackedSeconds: number;
  healthySeconds: number;
  staleSeconds: number;
  observedHours: number;
  hasEnoughDataForNines: boolean;
};

function parseDeviationRatio(snapshot: OracleSnapshot): number {
  const explicit = Number(snapshot.deviationRatio ?? "NaN");
  if (Number.isFinite(explicit)) return explicit;
  const threshold = Number(snapshot.rebalanceThreshold ?? 0);
  if (threshold <= 0) return NaN;
  return Number(snapshot.priceDifference ?? "0") / threshold;
}

function isHealthySnapshot(snapshot: OracleSnapshot): boolean {
  if (snapshot.hasHealthData === false) return false;
  if (snapshot.healthBinaryValue != null) {
    return Number(snapshot.healthBinaryValue) >= 1;
  }
  const d = parseDeviationRatio(snapshot);
  return Number.isFinite(d) && d <= 1.0;
}

/**
 * Compute binary health for a rolling window.
 *
 * Requirements:
 * - snapshots must be chronological ascending
 * - if available, include the latest predecessor snapshot before windowStart
 *   as snapshots[0], followed by in-window snapshots
 *
 * Semantics:
 * - pre-first-snapshot time is excluded from denominator (new pools not punished)
 * - after first snapshot, stale time counts as unhealthy
 * - nines only shown after >= 24h tracked coverage
 */
export function computeBinaryHealthWindow(
  snapshots: OracleSnapshot[],
  pool: Pick<Pool, "oracleExpiry">,
  chainId: number,
  windowStart: number,
  windowEnd: number,
): BinaryHealthWindow {
  if (snapshots.length === 0) {
    return {
      score: null,
      trackedSeconds: 0,
      healthySeconds: 0,
      staleSeconds: 0,
      observedHours: 0,
      hasEnoughDataForNines: false,
    };
  }

  const freshnessLimit = getOracleStalenessThreshold(pool, chainId);
  let trackedSeconds = 0;
  let healthySeconds = 0;
  let staleSeconds = 0;

  for (let i = 0; i < snapshots.length; i++) {
    const curr = snapshots[i]!;
    const currTs = Number(curr.timestamp);
    const nextTs =
      i + 1 < snapshots.length
        ? Number(snapshots[i + 1]!.timestamp)
        : windowEnd;

    const segmentStart = Math.max(currTs, windowStart);
    const segmentEnd = Math.min(nextTs, windowEnd);
    if (segmentEnd <= segmentStart) continue;

    const duration = segmentEnd - segmentStart;
    trackedSeconds += duration;

    // Once a snapshot exists, only freshnessLimit seconds can carry its state.
    const freshnessEnd = currTs + freshnessLimit;
    const carryEnd = Math.min(segmentEnd, freshnessEnd);
    const carrySeconds = Math.max(0, carryEnd - segmentStart);
    const stalePart = duration - carrySeconds;

    if (isHealthySnapshot(curr)) {
      healthySeconds += carrySeconds;
    }
    staleSeconds += Math.max(0, stalePart);
  }

  const score = trackedSeconds > 0 ? healthySeconds / trackedSeconds : null;
  const observedHours = trackedSeconds / 3600;
  return {
    score,
    trackedSeconds,
    healthySeconds,
    staleSeconds,
    observedHours,
    hasEnoughDataForNines: trackedSeconds >= 24 * 3600,
  };
}

export function formatBinaryHealthPct(score: number | null): string {
  if (score == null) return "N/A";
  return `${(score * 100).toFixed(1)}%`;
}

export function formatNines(score: number | null): string {
  if (score == null) return "N/A";
  const pct = score * 100;
  if (pct >= 99.999) return "5 nines";
  if (pct >= 99.99) return "4 nines";
  if (pct >= 99.9) return "3 nines";
  if (pct >= 99) return "2 nines";
  if (pct >= 90) return "1 nine";
  return "0 nines";
}
