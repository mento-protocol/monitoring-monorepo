import type { OracleSnapshot, Pool } from "@/lib/types";
import { tradingSecondsInRange } from "@/lib/weekend";

type BinaryHealthWindow = {
  score: number | null; // 0..1, null => no data
  trackedSeconds: number;
  healthySeconds: number;
  staleSeconds: number;
  observedHours: number;
  hasEnoughDataForNines: boolean;
};

/**
 * Parse deviationRatio from a snapshot for legacy fallback.
 * Returns NaN for no-data sentinels ("-1") and invalid values so callers
 * treat them as unhealthy rather than silently classifying them as healthy.
 * Only used for pre-migration snapshots without healthBinaryValue.
 */
function parseDeviationRatio(snapshot: OracleSnapshot): number {
  const explicit = Number(snapshot.deviationRatio ?? "NaN");
  // Guard: negative values are no-data sentinels ("-1"), not real ratios.
  // Without this, Number("-1") = -1 passes isFinite and returns -1 ≤ 1.0,
  // silently classifying a no-data interval as healthy.
  if (explicit < 0) return NaN;
  if (Number.isFinite(explicit)) return explicit;
  const threshold = Number(snapshot.rebalanceThreshold ?? 0);
  if (threshold <= 0) return NaN;
  // Legacy fallback: compute from raw fields. Uses float division which has
  // precision risk at d=1.0, but only applies to pre-migration rows without
  // deviationRatio string. Prefer parseFloat(deviationRatio) over raw division.
  return Number(snapshot.priceDifference ?? "0") / threshold;
}

function hasValidHealthData(snapshot: OracleSnapshot): boolean {
  // Strict equality: undefined (absent field during schema migration) must NOT
  // be treated as valid data. Use === true to exclude missing fields.
  return snapshot.hasHealthData === true;
}

function isHealthySnapshot(snapshot: OracleSnapshot): boolean {
  if (!hasValidHealthData(snapshot)) return false;
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
export function normalizeWindowSnapshots(
  rawSnapshotsDesc: OracleSnapshot[],
  maxSnapshots: number,
): { snapshotsAsc: OracleSnapshot[]; truncated: boolean } {
  const truncated = rawSnapshotsDesc.length > maxSnapshots;
  const keptDesc = truncated
    ? rawSnapshotsDesc.slice(0, maxSnapshots)
    : rawSnapshotsDesc;

  // Sort ascending with the same tie-breakers as the query
  // (timestamp asc, blockNumber asc, id asc) to ensure deterministic ordering
  // when multiple events share the same timestamp (same block).
  const snapshotsAsc = [...keptDesc].sort((a, b) => {
    const tsDiff = Number(a.timestamp) - Number(b.timestamp);
    if (tsDiff !== 0) return tsDiff;
    const bnDiff = Number(a.blockNumber) - Number(b.blockNumber);
    if (bnDiff !== 0) return bnDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { snapshotsAsc, truncated };
}

export function computeBinaryHealthWindow(
  snapshots: OracleSnapshot[],
  pool: Pick<Pool, "oracleExpiry">,
  windowStart: number,
  windowEnd: number,
): BinaryHealthWindow {
  const emptyResult: BinaryHealthWindow = {
    score: null,
    trackedSeconds: 0,
    healthySeconds: 0,
    staleSeconds: 0,
    observedHours: 0,
    hasEnoughDataForNines: false,
  };
  if (snapshots.length === 0 || windowEnd <= windowStart) {
    return emptyResult;
  }

  // Match indexer exactly: when oracleExpiry is 0/missing, indexer uses 3600s
  // (MAX_CARRY_SECONDS), not chain-specific fallbacks. Then cap at 3600s.
  const MAX_CARRY_SECONDS = 3600;
  const rawExpiry = Number(pool.oracleExpiry ?? "0");
  const oracleExpiry = rawExpiry > 0 ? rawExpiry : MAX_CARRY_SECONDS;
  const freshnessLimit = Math.min(oracleExpiry, MAX_CARRY_SECONDS);
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

    // Skip no-data snapshots entirely — don't count their intervals in the denominator
    if (!hasValidHealthData(curr)) continue;

    // Measure segment + carry in trading-seconds so FX weekend wall-clock
    // time is excluded from both numerator (healthy carry) and denominator
    // (tracked). See weekend.ts for half-open semantics.
    const duration = tradingSecondsInRange(segmentStart, segmentEnd);
    trackedSeconds += duration;

    // Freshness uses wall-clock: a snapshot expires at a wall-clock moment
    // regardless of weekend. The carry range is then re-measured in
    // trading-seconds below.
    const freshnessEnd = currTs + freshnessLimit;
    const carryEnd = Math.min(segmentEnd, freshnessEnd);
    const carrySeconds = tradingSecondsInRange(segmentStart, carryEnd);
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
  return `${(score * 100).toFixed(2)}%`;
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
