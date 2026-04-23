import type { NetworkData } from "@/hooks/use-all-networks-data";
import {
  globalPoolKey,
  type GlobalPoolEntry,
} from "@/components/global-pools-table";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import { buildPoolVolumeMap } from "@/lib/volume";
import type { Pool, PoolSnapshotWindow, TradingLimit } from "@/lib/types";
import type { Network } from "@/lib/networks";
import type { OracleRateMap } from "@/lib/tokens";

type DerivedEntries = {
  entries: GlobalPoolEntry[];
  volume24hByKey: Map<string, number | null | undefined>;
  volume7dByKey: Map<string, number | null | undefined>;
  /**
   * Per-pool 7d TVL change in percent. Three states:
   *  - `number` — real WoW value,
   *  - `null`   — backend snapshot query failed for that chain,
   *  - absent   — no comparable 7d snapshot for that pool.
   */
  tvlChangeWoWByKey: Map<string, number | null>;
  /** Per-pool trading limits keyed by globalPoolKey → TradingLimit[] (2 per FPMM pool). */
  tradingLimitsByKey: Map<string, TradingLimit[]>;
  /** Set of globalPoolKeys that have an active OLS strategy. */
  olsPoolKeys: Set<string>;
  /** Set of globalPoolKeys whose rebalancer is a CDPLiquidityStrategy. */
  cdpPoolKeys: Set<string>;
};

function perPoolTvlWindow(
  snapshots: PoolSnapshotWindow[],
  pools: Pool[],
  network: Network,
  rates: OracleRateMap,
): Map<string, { now: number; ago: number }> {
  const fpmmMap = new Map(pools.filter(isFpmm).map((p) => [p.id, p]));
  const earliest = new Map<string, PoolSnapshotWindow>();
  for (const s of snapshots) {
    if (!fpmmMap.has(s.poolId)) continue;
    const existing = earliest.get(s.poolId);
    if (!existing || Number(s.timestamp) < Number(existing.timestamp)) {
      earliest.set(s.poolId, s);
    }
  }
  const result = new Map<string, { now: number; ago: number }>();
  for (const [poolId, snap] of earliest) {
    const pool = fpmmMap.get(poolId)!;
    result.set(poolId, {
      now: poolTvlUSD(pool, network, rates),
      ago: poolTvlUSD(
        { ...pool, reserves0: snap.reserves0, reserves1: snap.reserves1 },
        network,
        rates,
      ),
    });
  }
  return result;
}

/**
 * Build per-pool entries (pool × network × rates) and windowed volume / WoW
 * maps keyed by `globalPoolKey`, suitable for rendering <GlobalPoolsTable>.
 * Skips networks whose top-level pools query failed.
 */
export function buildGlobalPoolEntries(
  networkData: NetworkData[],
): DerivedEntries {
  const entries: GlobalPoolEntry[] = [];
  const volume24hByKey = new Map<string, number | null | undefined>();
  const volume7dByKey = new Map<string, number | null | undefined>();
  const tvlChangeWoWByKey = new Map<string, number | null>();
  const tradingLimitsByKey = new Map<string, TradingLimit[]>();
  const olsPoolKeys = new Set<string>();
  const cdpPoolKeys = new Set<string>();

  for (const netData of networkData) {
    if (netData.error !== null) continue;
    const { network, pools, snapshots, snapshots7d, rates } = netData;

    // Build per-pool trading limit lookup from the chain-level flat list
    const tlByPoolId = new Map<string, TradingLimit[]>();
    for (const tl of netData.tradingLimits) {
      const arr = tlByPoolId.get(tl.poolId) ?? [];
      arr.push(tl);
      tlByPoolId.set(tl.poolId, arr);
    }

    const vol24hMap =
      netData.snapshotsError === null
        ? buildPoolVolumeMap(snapshots, pools, network, rates)
        : null;
    const vol7dMap =
      netData.snapshots7dError === null
        ? buildPoolVolumeMap(snapshots7d, pools, network, rates)
        : null;

    const perPool7dTvl =
      netData.snapshots7dError === null && snapshots7d.length > 0
        ? perPoolTvlWindow(snapshots7d, pools, network, rates)
        : null;

    for (const pool of pools) {
      const entry: GlobalPoolEntry = { pool, network, rates };
      entries.push(entry);
      const key = globalPoolKey(entry);
      volume24hByKey.set(key, vol24hMap ? vol24hMap.get(pool.id) : null);
      volume7dByKey.set(key, vol7dMap ? vol7dMap.get(pool.id) : null);

      if (netData.snapshots7dError !== null) {
        tvlChangeWoWByKey.set(key, null);
      } else {
        const v = perPool7dTvl?.get(pool.id);
        if (v && v.ago > 0) {
          tvlChangeWoWByKey.set(key, ((v.now - v.ago) / v.ago) * 100);
        }
      }

      const tls = tlByPoolId.get(pool.id);
      if (tls) tradingLimitsByKey.set(key, tls);

      if (netData.olsPoolIds.has(pool.id)) olsPoolKeys.add(key);
      if (netData.cdpPoolIds.has(pool.id)) cdpPoolKeys.add(key);
    }
  }

  return {
    entries,
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
    tradingLimitsByKey,
    olsPoolKeys,
    cdpPoolKeys,
  };
}
