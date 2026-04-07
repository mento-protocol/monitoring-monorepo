import { parseWei } from "./format";
import { tokenSymbol, USDM_SYMBOLS } from "./tokens";
import type { Network } from "./networks";
import type { Pool, PoolSnapshotWindow } from "./types";

/**
 * Compute all-time total volume in USD for a pool.
 *
 * Returns null when the pool has no USD-convertible leg (i.e. neither token
 * is in USDM_SYMBOLS). Returns 0 when the pool is USD-convertible but has no
 * recorded volume yet (notionalVolume fields absent or "0").
 */
export function poolTotalVolumeUSD(
  pool: Pool,
  network: Network,
): number | null {
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  if (USDM_SYMBOLS.has(sym0)) {
    return parseWei(pool.notionalVolume0 ?? "0", pool.token0Decimals ?? 18);
  }
  if (USDM_SYMBOLS.has(sym1)) {
    return parseWei(pool.notionalVolume1 ?? "0", pool.token1Decimals ?? 18);
  }
  return null;
}

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;

/** Shared refresh interval (ms) for snapshot and fee queries (5 minutes). */
export const SNAPSHOT_REFRESH_MS = 300_000;

export function hourBucket(timestampSeconds: number): number {
  return Math.floor(timestampSeconds / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
}

export function snapshotWindow24h(nowMs: number): { from: number; to: number } {
  const nowSeconds = Math.floor(nowMs / 1000);
  const to = hourBucket(nowSeconds);
  return {
    from: to - SECONDS_PER_DAY,
    to,
  };
}

export function snapshotWindow7d(nowMs: number): { from: number; to: number } {
  const nowSeconds = Math.floor(nowMs / 1000);
  const to = hourBucket(nowSeconds);
  return {
    from: to - SECONDS_PER_WEEK,
    to,
  };
}

export function snapshotWindow30d(nowMs: number): { from: number; to: number } {
  const nowSeconds = Math.floor(nowMs / 1000);
  const to = hourBucket(nowSeconds);
  return {
    from: to - SECONDS_PER_MONTH,
    to,
  };
}

export function shouldQueryPoolSnapshots(poolIds: readonly string[]): boolean {
  return poolIds.length > 0;
}

export function buildPoolVolumeMap(
  snapshots: PoolSnapshotWindow[],
  pools: Pool[],
  network: Network,
): Map<string, number | null> {
  const poolById = new Map<string, Pool>(pools.map((pool) => [pool.id, pool]));
  const volumeByPool = new Map<string, number | null>();

  for (const pool of pools) {
    if (!isUsdConvertible(pool, network)) {
      volumeByPool.set(pool.id, null);
    }
  }

  for (const snapshot of snapshots) {
    const pool = poolById.get(snapshot.poolId);
    const volume = getSnapshotVolumeInUsd(snapshot, pool, network);
    const existingVolume = volumeByPool.get(snapshot.poolId);
    if (volume === null) {
      volumeByPool.set(snapshot.poolId, null);
      continue;
    }
    if (existingVolume === null) {
      continue;
    }
    volumeByPool.set(snapshot.poolId, (existingVolume ?? 0) + volume);
  }

  return volumeByPool;
}

function getSnapshotVolumeInUsd(
  snapshot: PoolSnapshotWindow,
  pool: Pool | undefined,
  network: Network,
): number | null {
  if (!pool || !isUsdConvertible(pool, network)) return null;
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  if (USDM_SYMBOLS.has(sym0)) {
    return parseWei(snapshot.swapVolume0, pool.token0Decimals ?? 18);
  }
  if (USDM_SYMBOLS.has(sym1)) {
    return parseWei(snapshot.swapVolume1, pool.token1Decimals ?? 18);
  }
  return null;
}

export function sumFpmmSwaps(
  snapshots: PoolSnapshotWindow[],
  fpmmPoolIds: ReadonlySet<string>,
): number {
  return snapshots
    .filter((s) => fpmmPoolIds.has(s.poolId))
    .reduce((sum, s) => sum + s.swapCount, 0);
}

function isUsdConvertible(
  pool: Pick<Pool, "token0" | "token1">,
  network: Network,
): boolean {
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  return USDM_SYMBOLS.has(sym0) || USDM_SYMBOLS.has(sym1);
}
