import { parseWei } from "./format";
import {
  tokenSymbol,
  USDM_SYMBOLS,
  tokenToUSD,
  type OracleRateMap,
} from "./tokens";
import type { Network } from "./networks";
import type { Pool, PoolSnapshotWindow } from "./types";

export type TimeRange = { from: number; to: number };

export type SnapshotWindows = {
  w24h: TimeRange;
  w7d: TimeRange;
  w30d: TimeRange;
};

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
  // Same untrusted-decimals gate as `getSnapshotVolumeInUsd` — a non-18-dp
  // leg with `tokenDecimalsKnown !== true` would scale `notionalVolume0/1`
  // (in raw token wei) by `1e18` instead of the real `1e6` and overstate
  // all-time USD volume by 1e12. Strict `!== true` (not `=== false`):
  // `undefined` represents either pre-PR-1.5 indexer schema OR a transient
  // EXT-query failure — both should fail closed. Post-PR-1.6 indexer
  // populates the field on every pool, so `undefined` is a real signal,
  // not a deploy-window default.
  if (pool.tokenDecimalsKnown !== true) return null;
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

export function snapshotWindow24h(nowMs: number): TimeRange {
  const nowSeconds = Math.floor(nowMs / 1000);
  const to = hourBucket(nowSeconds);
  return {
    from: to - SECONDS_PER_DAY,
    to,
  };
}

export function snapshotWindow7d(nowMs: number): TimeRange {
  const nowSeconds = Math.floor(nowMs / 1000);
  const to = hourBucket(nowSeconds);
  return {
    from: to - SECONDS_PER_WEEK,
    to,
  };
}

export function snapshotWindow30d(nowMs: number): TimeRange {
  const nowSeconds = Math.floor(nowMs / 1000);
  const to = hourBucket(nowSeconds);
  return {
    from: to - SECONDS_PER_30_DAYS,
    to,
  };
}

export function buildSnapshotWindows(nowMs: number): SnapshotWindows {
  return {
    w24h: snapshotWindow24h(nowMs),
    w7d: snapshotWindow7d(nowMs),
    w30d: snapshotWindow30d(nowMs),
  };
}

export function snapshotWindowPrior7dFromCurrent(window: TimeRange): TimeRange {
  return {
    from: window.from - SECONDS_PER_WEEK,
    to: window.from,
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
  return snapshotWindowPrior7dFromCurrent(snapshotWindow7d(nowMs));
}

export function shouldQueryPoolSnapshots(poolIds: readonly string[]): boolean {
  return poolIds.length > 0;
}

export function sumVolumeMap(map: ReadonlyMap<string, number | null>): number {
  let total = 0;
  for (const value of map.values()) {
    if (typeof value === "number") total += value;
  }
  return total;
}

export function filterSnapshotsToWindow(
  snapshots: PoolSnapshotWindow[],
  window: TimeRange,
): PoolSnapshotWindow[] {
  return snapshots.filter((snapshot) => {
    const timestamp = Number(snapshot.timestamp);
    return timestamp >= window.from && timestamp < window.to;
  });
}

export function buildPoolVolumeMapInWindow(
  snapshots: PoolSnapshotWindow[],
  pools: Pool[],
  network: Network,
  rates: OracleRateMap,
  window: TimeRange,
): Map<string, number | null> {
  return buildPoolVolumeMap(
    filterSnapshotsToWindow(snapshots, window),
    pools,
    network,
    rates,
  );
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
  // `parseWei` below scales by `pool.tokenNDecimals ?? 18`. If the
  // indexer hasn't yet read on-chain decimals (`tokenDecimalsKnown=false`),
  // those fields hold the schema-default 18 — a 6-dp USDC leg would be
  // scaled by 1e18 and produce a 1e12-fold USD overstatement. The indexer
  // already suppresses `SwapEvent.volumeUsdWei` in that case; mirror the
  // gate here so snapshot-derived volumes stay null too. Undefined flag
  // (deploy-window schema-lag) trusts the legacy schema-default 18 path
  // so existing pools don't blank — only an explicit `false` short-circuits.
  if (pool.tokenDecimalsKnown !== true) return null;
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
