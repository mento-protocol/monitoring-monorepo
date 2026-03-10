import { parseWei } from "./format";
import { tokenSymbol, USDM_SYMBOLS } from "./tokens";
import type { Network } from "./networks";
import type { Pool, PoolSnapshot24h } from "./types";

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

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

export function shouldQueryPoolSnapshots24h(
  poolIds: readonly string[],
): boolean {
  return poolIds.length > 0;
}

export function buildPool24hVolumeMap(
  snapshots: PoolSnapshot24h[],
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
  snapshot: PoolSnapshot24h,
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

export function sumFpmmSwaps24h(
  snapshots: PoolSnapshot24h[],
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
