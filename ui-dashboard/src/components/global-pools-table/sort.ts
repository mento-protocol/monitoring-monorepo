import { computeEffectiveStatus, computePoolUptimePct } from "@/lib/health";
import { sortedCopy } from "@/lib/immutable-sort";
import type { Network } from "@/lib/networks";
import type { SortDir } from "@/lib/table-sort";
import { poolName, type OracleRateMap } from "@/lib/tokens";
import type { Pool } from "@/lib/types";
import { hasFeeData } from "./formatting";

/** A pool entry enriched with its originating network and oracle rates. */
export type GlobalPoolEntry = {
  pool: Pool;
  network: Network;
  rates: OracleRateMap;
};

export type GlobalSortKey =
  | "pool"
  | "health"
  | "uptime"
  | "fee"
  | "tvl"
  | "tvlChangeWoW"
  | "volume24h"
  | "volume7d"
  | "totalVolume";

// URL-settable sort keys. Excludes "tvlChangeWoW": the WoW delta renders as a
// secondary line inside the TVL cell rather than as its own sortable header, so
// it has no header to expose `aria-sort`. Keeping it out of this set means a
// stale deep link (?poolsSort=tvlChangeWoW) falls back to the default "tvl
// desc" instead of sorting by an invisible column. The comparator below still
// handles it so it can be re-promoted to a sortable header without re-deriving
// the sort logic.
export const GLOBAL_SORT_KEYS: ReadonlySet<GlobalSortKey> = new Set([
  "pool",
  "health",
  "uptime",
  "fee",
  "tvl",
  "volume24h",
  "volume7d",
  "totalVolume",
]);

// Higher rank = more severe. "desc" puts highest rank first → CRITICAL first.
// Mirrors STATUS_RANK in lib/health.ts: HALTED outranks WEEKEND/WARN (a halted
// pool deserves attention) but sits below CRITICAL.
const HEALTH_ORDER: Record<string, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  WEEKEND: 3,
  HALTED: 4,
  CRITICAL: 5,
};

/** Build a unique key for a pool entry so pools from different chains with the same ID don't collide. */
export function globalPoolKey(entry: GlobalPoolEntry): string {
  return `${entry.network.id}:${entry.pool.id}`;
}

export interface GlobalSortContext {
  tvlByKey: Map<string, number | null>;
  totalVolumeByKey: Map<string, number | null>;
  nowSeconds?: number | undefined;
  volume24hByKey?: Map<string, number | null | undefined> | undefined;
  volume7dByKey?: Map<string, number | null | undefined> | undefined;
  tvlChangeWoWByKey?: Map<string, number | null> | undefined;
}

export function sortGlobalPools(
  entries: GlobalPoolEntry[],
  sortKey: GlobalSortKey,
  sortDir: SortDir,
  {
    tvlByKey,
    totalVolumeByKey,
    nowSeconds = Math.floor(Date.now() / 1000),
    volume24hByKey,
    volume7dByKey,
    tvlChangeWoWByKey,
  }: GlobalSortContext,
): GlobalPoolEntry[] {
  return sortedCopy(entries, (a, b) => {
    const [aKey, bKey] = [globalPoolKey(a), globalPoolKey(b)];
    let cmp = 0;
    switch (sortKey) {
      case "pool":
        cmp = poolName(a.network, a.pool.token0, a.pool.token1).localeCompare(
          poolName(b.network, b.pool.token0, b.pool.token1),
        );
        break;
      case "health": {
        const aH = computeEffectiveStatus(
          a.pool,
          a.network.chainId,
          nowSeconds,
        );
        const bH = computeEffectiveStatus(
          b.pool,
          b.network.chainId,
          nowSeconds,
        );
        cmp = (HEALTH_ORDER[aH] ?? 99) - (HEALTH_ORDER[bH] ?? 99);
        break;
      }
      case "uptime": {
        // Unknown uptime sinks to the bottom regardless of direction.
        const aUptime = computePoolUptimePct(a.pool, nowSeconds);
        const bUptime = computePoolUptimePct(b.pool, nowSeconds);
        if (aUptime == null && bUptime == null) return 0;
        if (aUptime == null) return 1;
        if (bUptime == null) return -1;
        return sortDir === "asc" ? aUptime - bUptime : bUptime - aUptime;
      }
      case "fee": {
        const aHas = hasFeeData(a.pool);
        const bHas = hasFeeData(b.pool);
        if (!aHas && !bHas) return 0;
        if (!aHas) return 1;
        if (!bHas) return -1;
        const aFee = (a.pool.lpFee ?? 0) + (a.pool.protocolFee ?? 0);
        const bFee = (b.pool.lpFee ?? 0) + (b.pool.protocolFee ?? 0);
        return sortDir === "asc" ? aFee - bFee : bFee - aFee;
      }
      case "tvl": {
        const aTvl = tvlByKey.get(aKey);
        const bTvl = tvlByKey.get(bKey);
        if (aTvl == null && bTvl == null) return 0;
        if (aTvl == null) return 1;
        if (bTvl == null) return -1;
        return sortDir === "asc" ? aTvl - bTvl : bTvl - aTvl;
      }
      case "tvlChangeWoW": {
        // Both error (null) and missing-data (undefined) sink regardless of direction.
        const aW = tvlChangeWoWByKey?.get(aKey);
        const bW = tvlChangeWoWByKey?.get(bKey);
        const aMissing = aW == null;
        const bMissing = bW == null;
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return sortDir === "asc" ? aW - bW : bW - aW;
      }
      case "volume24h": {
        const aV = volume24hByKey?.get(aKey);
        const bV = volume24hByKey?.get(bKey);
        if (aV == null && bV == null) return 0;
        if (aV == null) return 1;
        if (bV == null) return -1;
        return sortDir === "asc" ? aV - bV : bV - aV;
      }
      case "volume7d": {
        const aV7 = volume7dByKey?.get(aKey);
        const bV7 = volume7dByKey?.get(bKey);
        if (aV7 == null && bV7 == null) return 0;
        if (aV7 == null) return 1;
        if (bV7 == null) return -1;
        return sortDir === "asc" ? aV7 - bV7 : bV7 - aV7;
      }
      case "totalVolume": {
        const aTV = totalVolumeByKey.get(aKey);
        const bTV = totalVolumeByKey.get(bKey);
        if (aTV == null && bTV == null) return 0;
        if (aTV == null) return 1;
        if (bTV == null) return -1;
        return sortDir === "asc" ? aTV - bTV : bTV - aTV;
      }
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
}
