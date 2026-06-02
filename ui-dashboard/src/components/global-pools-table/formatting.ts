import type { Pool } from "@/lib/types";

export type PoolStrategyLabel = "Open" | "CDP" | "Reserve";

export function poolStrategies(
  isOls: boolean,
  isCdp: boolean,
  isReserve: boolean,
): PoolStrategyLabel[] {
  // Precedence: OLS (indexer-tracked) > CDP > Reserve. All three require a
  // positive signal. Indexed Celo currently has a positive CDP source but no
  // positive Reserve source; fallback-network RPC probe failures also leave
  // the pool out of every set rather than misclassifying it as Reserve.
  if (isOls) return ["Open"];
  if (isCdp) return ["CDP"];
  if (isReserve) return ["Reserve"];
  return [];
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
