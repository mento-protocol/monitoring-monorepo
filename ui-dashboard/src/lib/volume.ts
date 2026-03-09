import { parseWei } from "./format";
import { tokenSymbol, USDM_SYMBOLS } from "./tokens";
import type { Network } from "./networks";
import type { Pool, PoolSnapshot24h } from "./types";

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

export function hourBucket(timestampSeconds: number): number {
  return Math.floor(timestampSeconds / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
}

export function snapshotSince24h(nowMs: number): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  return hourBucket(nowSeconds) - SECONDS_PER_DAY;
}

export function buildPool24hVolumeMap(
  snapshots: PoolSnapshot24h[],
  pools: Pool[],
  network: Network,
): Map<string, number | null> {
  const poolById = new Map<string, Pool>(pools.map((pool) => [pool.id, pool]));
  const volumeByPool = new Map<string, number | null>();

  for (const pool of pools) {
    if (!isUsdConvertible(pool)) {
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
  if (!pool || !isUsdConvertible(pool)) return null;
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  return usdmIsToken0
    ? parseWei(snapshot.swapVolume0, pool.token0Decimals ?? 18)
    : parseWei(snapshot.swapVolume1, pool.token1Decimals ?? 18);
}

function isUsdConvertible(pool: Pick<Pool, "oraclePrice">): boolean {
  return Boolean(pool.oraclePrice && pool.oraclePrice !== "0");
}
