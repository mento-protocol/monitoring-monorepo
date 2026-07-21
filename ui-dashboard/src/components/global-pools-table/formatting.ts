import type { Pool } from "@/lib/types";

export type PoolStrategyLabel = "Open" | "CDP" | "Reserve";

export function poolStrategies(
  isOls: boolean,
  isCdp: boolean,
  isReserve: boolean,
): PoolStrategyLabel[] {
  // All three require a positive signal; missing classification leaves the
  // pool out of every set rather than misclassifying it as Reserve. Do not
  // collapse simultaneous strategies: Polygon's EURm/EUROP pool deliberately
  // authorizes both Open and Reserve.
  const labels: PoolStrategyLabel[] = [];
  if (isOls) labels.push("Open");
  if (isCdp) labels.push("CDP");
  if (isReserve) labels.push("Reserve");
  return labels;
}

// Fee display

export function hasFeeData(pool: Pool): boolean {
  if (pool.source?.includes("virtual")) return false;
  if (pool.lpFee == null && pool.protocolFee == null) return false;
  // Sentinel -1 means fees were never successfully fetched
  if ((pool.lpFee ?? -1) < 0 || (pool.protocolFee ?? -1) < 0) return false;
  return true;
}

export function formatFee(pool: Pool): string {
  if (!hasFeeData(pool)) return "—";
  const total = (pool.lpFee ?? 0) + (pool.protocolFee ?? 0);
  return `${(total / 100).toFixed(2)}%`;
}
