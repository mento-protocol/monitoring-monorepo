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
): Map<string, number> {
  const poolById = new Map<string, Pool>(pools.map((pool) => [pool.id, pool]));

  return snapshots.reduce((volumeByPool, snapshot) => {
    const pool = poolById.get(snapshot.poolId);
    const volume = getSnapshotVolumeInUsd(snapshot, pool, network);
    const existingVolume = volumeByPool.get(snapshot.poolId) ?? 0;
    volumeByPool.set(snapshot.poolId, existingVolume + volume);
    return volumeByPool;
  }, new Map<string, number>());
}

function getSnapshotVolumeInUsd(
  snapshot: PoolSnapshot24h,
  pool: Pool | undefined,
  network: Network,
): number {
  if (pool?.oraclePrice && pool.oraclePrice !== "0") {
    const sym0 = tokenSymbol(network, pool.token0 ?? null);
    const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
    return usdmIsToken0
      ? parseWei(snapshot.swapVolume0, pool.token0Decimals ?? 18)
      : parseWei(snapshot.swapVolume1, pool.token1Decimals ?? 18);
  }

  return (
    parseWei(snapshot.swapVolume0, pool?.token0Decimals ?? 18) +
    parseWei(snapshot.swapVolume1, pool?.token1Decimals ?? 18)
  );
}
