import type { NetworkData } from "@/hooks/use-all-networks-data";
import {
  globalPoolKey,
  type GlobalPoolEntry,
} from "@/components/global-pools-table";
import { isFpmm, poolTvlUSD } from "@/lib/tokens";
import { buildPoolVolumeMap } from "@/lib/volume";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";
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
  /** Set of globalPoolKeys that have an active OLS strategy. */
  olsPoolKeys: Set<string>;
  /** Set of globalPoolKeys classified as CDP by Celo CdpPool rows. */
  cdpPoolKeys: Set<string>;
  /**
   * Set of globalPoolKeys classified as Reserve. Indexed Celo withholds this
   * without a positive indexed source; fallback networks use the RPC probe.
   * Pools with a rebalancer that appear in none of {ols, cdp, reserve} are
   * "strategy detection unavailable", not known Reserve.
   */
  reservePoolKeys: Set<string>;
};

type WindowedPoolMaps = {
  vol24hMap: Map<string, number | null | undefined> | null;
  vol7dMap: Map<string, number | null | undefined> | null;
  perPool7dTvl: Map<string, { now: number | null; ago: number | null }> | null;
};

type NetworkEntryContext = WindowedPoolMaps & {
  network: Network;
  rates: OracleRateMap;
  snapshots7dError: NetworkData["snapshots7dError"];
  olsPoolIds: Set<string>;
  cdpPoolIds: Set<string>;
  reservePoolIds: Set<string>;
};

function perPoolTvlWindow(
  snapshots: PoolSnapshotWindow[],
  pools: Pool[],
  network: Network,
  rates: OracleRateMap,
): Map<string, { now: number | null; ago: number | null }> {
  const fpmmMap = new Map(
    pools.flatMap((p) => (isFpmm(p) ? [[p.id, p] as const] : [])),
  );
  const earliest = new Map<string, PoolSnapshotWindow>();
  for (const s of snapshots) {
    if (!fpmmMap.has(s.poolId)) continue;
    const existing = earliest.get(s.poolId);
    if (!existing || Number(s.timestamp) < Number(existing.timestamp)) {
      earliest.set(s.poolId, s);
    }
  }
  // `null` propagates "TVL unknowable for this pool" (untrusted decimals)
  // up to consumers — see `poolTvlUSD` in `lib/tokens.ts` for the rationale.
  const result = new Map<string, { now: number | null; ago: number | null }>();
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

function windowedPoolMaps(netData: NetworkData): WindowedPoolMaps {
  const { network, pools, snapshots, snapshots7d, rates } = netData;
  return {
    vol24hMap:
      netData.snapshotsError === null
        ? buildPoolVolumeMap(snapshots, pools, network, rates)
        : null,
    vol7dMap:
      netData.snapshots7dError === null
        ? buildPoolVolumeMap(snapshots7d, pools, network, rates)
        : null,
    perPool7dTvl:
      netData.snapshots7dError === null && snapshots7d.length > 0
        ? perPoolTvlWindow(snapshots7d, pools, network, rates)
        : null,
  };
}

function addTvlChange(
  result: DerivedEntries,
  key: string,
  poolId: string,
  context: NetworkEntryContext,
): void {
  if (context.snapshots7dError !== null) {
    result.tvlChangeWoWByKey.set(key, null);
    return;
  }
  const v = context.perPool7dTvl?.get(poolId);
  // Untrusted-decimals pools surface as null on either side — skip
  // the WoW computation entirely so the column degrades to "—".
  if (v && v.now !== null && v.ago !== null && v.ago > 0) {
    result.tvlChangeWoWByKey.set(key, ((v.now - v.ago) / v.ago) * 100);
  }
}

function addStrategyKeys(
  result: DerivedEntries,
  key: string,
  poolId: string,
  context: NetworkEntryContext,
): void {
  if (context.olsPoolIds.has(poolId)) result.olsPoolKeys.add(key);
  if (context.cdpPoolIds.has(poolId)) result.cdpPoolKeys.add(key);
  if (context.reservePoolIds.has(poolId)) result.reservePoolKeys.add(key);
}

function addPoolEntry(
  result: DerivedEntries,
  pool: Pool,
  context: NetworkEntryContext,
): void {
  const entry: GlobalPoolEntry = {
    pool,
    network: context.network,
    rates: context.rates,
  };
  result.entries.push(entry);
  const key = globalPoolKey(entry);
  result.volume24hByKey.set(
    key,
    context.vol24hMap ? context.vol24hMap.get(pool.id) : null,
  );
  result.volume7dByKey.set(
    key,
    context.vol7dMap ? context.vol7dMap.get(pool.id) : null,
  );
  addTvlChange(result, key, pool.id, context);
  addStrategyKeys(result, key, pool.id, context);
}

function addNetworkEntries(result: DerivedEntries, netData: NetworkData): void {
  if (netData.error !== null) return;
  const { network, pools, rates } = netData;
  const context: NetworkEntryContext = {
    network,
    rates,
    snapshots7dError: netData.snapshots7dError,
    olsPoolIds: netData.olsPoolIds,
    cdpPoolIds: netData.cdpPoolIds,
    reservePoolIds: netData.reservePoolIds,
    ...windowedPoolMaps(netData),
  };
  for (const pool of pools) {
    addPoolEntry(result, pool, context);
  }
}

/**
 * Build per-pool entries (pool × network × rates), windowed volume / WoW maps,
 * and strategy sets keyed by `globalPoolKey`, suitable for rendering
 * <GlobalPoolsTable>.
 * Skips networks whose top-level pools query failed.
 */
export function buildGlobalPoolEntries(
  networkData: NetworkData[],
): DerivedEntries {
  const result: DerivedEntries = {
    entries: [],
    volume24hByKey: new Map(),
    volume7dByKey: new Map(),
    tvlChangeWoWByKey: new Map(),
    olsPoolKeys: new Set(),
    cdpPoolKeys: new Set(),
    reservePoolKeys: new Set(),
  };

  for (const netData of networkData) {
    addNetworkEntries(result, netData);
  }

  return result;
}
