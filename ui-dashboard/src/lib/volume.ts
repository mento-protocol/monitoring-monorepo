import { parseWei } from "./format";
import {
  tokenSymbol,
  USDM_SYMBOLS,
  tokenToUSD,
  type OracleRateMap,
} from "./tokens";
import type { Network } from "./networks";
import type { Pool, PoolSnapshotWindow } from "./types";

/**
 * Compute all-time total volume in USD for a pool.
 *
 * Prefers the USDm leg (1:1 USD). Falls back to oracle-rate conversion for
 * non-USDm tokens (e.g. EURm, axlEUROC). Returns null only when neither
 * token has a known USD conversion.
 */
export function poolTotalVolumeUSD(
  pool: Pool,
  network: Network,
  rates: OracleRateMap,
): number | null {
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  if (USDM_SYMBOLS.has(sym0)) {
    return parseWei(pool.notionalVolume0 ?? "0", pool.token0Decimals ?? 18);
  }
  if (USDM_SYMBOLS.has(sym1)) {
    return parseWei(pool.notionalVolume1 ?? "0", pool.token1Decimals ?? 18);
  }
  return (
    volumeViaFxRate(sym0, pool.notionalVolume0, pool.token0Decimals, rates) ??
    volumeViaFxRate(sym1, pool.notionalVolume1, pool.token1Decimals, rates)
  );
}

function volumeViaFxRate(
  symbol: string,
  rawVolume: string | undefined,
  decimals: number | undefined,
  rates: OracleRateMap,
): number | null {
  const amount = parseWei(rawVolume ?? "0", decimals ?? 18);
  return tokenToUSD(symbol, amount, rates);
}

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const SECONDS_PER_30_DAYS = 30 * SECONDS_PER_DAY;

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
    from: to - SECONDS_PER_30_DAYS,
    to,
  };
}

/**
 * Window covering the 7 days immediately preceding the current 7-day window —
 * i.e. [now - 14d, now - 7d]. Used to compute week-over-week volume deltas
 * without refetching: the caller filters `snapshots30d` by this window.
 */
export function snapshotWindowPrior7d(nowMs: number): {
  from: number;
  to: number;
} {
  const nowSeconds = Math.floor(nowMs / 1000);
  const to = hourBucket(nowSeconds) - SECONDS_PER_WEEK;
  return {
    from: to - SECONDS_PER_WEEK,
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
  rates: OracleRateMap,
): Map<string, number | null> {
  const poolById = new Map<string, Pool>(pools.map((pool) => [pool.id, pool]));
  const volumeByPool = new Map<string, number | null>();

  for (const pool of pools) {
    if (!isUsdConvertible(pool, network, rates)) {
      volumeByPool.set(pool.id, null);
    }
  }

  for (const snapshot of snapshots) {
    const pool = poolById.get(snapshot.poolId);
    const volume = getSnapshotVolumeInUsd(snapshot, pool, network, rates);
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

export function getSnapshotVolumeInUsd(
  snapshot: PoolSnapshotWindow,
  pool: Pool | undefined,
  network: Network,
  rates: OracleRateMap,
): number | null {
  if (!pool || !isUsdConvertible(pool, network, rates)) return null;
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  if (USDM_SYMBOLS.has(sym0)) {
    return parseWei(snapshot.swapVolume0, pool.token0Decimals ?? 18);
  }
  if (USDM_SYMBOLS.has(sym1)) {
    return parseWei(snapshot.swapVolume1, pool.token1Decimals ?? 18);
  }
  return (
    volumeViaFxRate(sym0, snapshot.swapVolume0, pool.token0Decimals, rates) ??
    volumeViaFxRate(sym1, snapshot.swapVolume1, pool.token1Decimals, rates)
  );
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
  rates: OracleRateMap,
): boolean {
  const sym0 = tokenSymbol(network, pool.token0 ?? null);
  const sym1 = tokenSymbol(network, pool.token1 ?? null);
  return (
    USDM_SYMBOLS.has(sym0) ||
    USDM_SYMBOLS.has(sym1) ||
    tokenToUSD(sym0, 1, rates) !== null ||
    tokenToUSD(sym1, 1, rates) !== null
  );
}
