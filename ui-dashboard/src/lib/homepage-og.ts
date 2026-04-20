import { unstable_cache } from "next/cache";
import { GraphQLClient } from "graphql-request";
import { NETWORKS, NETWORK_IDS, type Network } from "@/lib/networks";
import {
  buildOracleRateMap,
  canValueTvl,
  isFpmm,
  poolName,
  poolTvlUSD,
  tokenSymbol,
  tokenToUSD,
  USDM_SYMBOLS,
  type OracleRateMap,
} from "@/lib/tokens";
import { computeEffectiveStatus, type HealthStatus } from "@/lib/health";
import { ALL_POOLS_WITH_HEALTH } from "@/lib/queries";
import { parseWei } from "@/lib/format";
import type { Pool, PoolSnapshot } from "@/lib/types";

const SECONDS_PER_DAY = 86_400;
const SEVEN_DAYS = 7 * SECONDS_PER_DAY;
const FOURTEEN_DAYS = 14 * SECONDS_PER_DAY;
const SPARKLINE_DAYS = 14;
const MAX_ATTENTION_POOLS = 3;

// Lean cross-chain daily-snapshot query. Fixed row cap instead of a
// timestamp filter because Hasura's `timestamp: { _gte }` does a lexical
// string comparison (the column stores numeric-looking strings), which
// silently drops all rows for certain cutoffs. 500 rows gives headroom
// for ~30 pools × 14 days; client-side filters to the [now-14d, now)
// window after fetch.
const HOMEPAGE_OG_DAILY_SNAPSHOTS = `
  query HomepageOgDailySnapshots($poolIds: [String!]!) {
    PoolDailySnapshot(
      where: { poolId: { _in: $poolIds } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: 500
    ) {
      poolId
      timestamp
      reserves0
      reserves1
      swapVolume0
      swapVolume1
    }
  }
`;

export type AttentionPool = {
  name: string;
  chainLabel: string;
  health: HealthStatus;
};

export type HomepageOgData = {
  totalTvlUsd: number | null;
  tvlWoWPct: number | null;
  totalVolume7dUsd: number | null;
  volume7dWoWPct: number | null;
  /** Chronological daily USD volume, oldest→newest, up to 14 points. */
  volumeSeries: number[];
  /** Chronological daily aggregate TVL across all pools, oldest→newest,
   * up to 14 points. Per day: sum of pool TVLs computed from that day's
   * reserves snapshot × current oracle rates. Days where no pool had a
   * snapshot are omitted (no carry-forward). */
  tvlSeries: number[];
  poolCount: number;
  chainCount: number;
  chains: string[];
  healthBuckets: Record<HealthStatus, number>;
  /** Pools in WARN/CRITICAL state, highest severity first, up to 3. */
  attentionPools: AttentionPool[];
};

type ChainSlice = {
  network: Network;
  pools: Pool[];
  daily: PoolSnapshot[];
  rates: OracleRateMap;
};

function makeClient(network: Network): GraphQLClient {
  const secret = network.hasuraSecret.trim();
  return new GraphQLClient(network.hasuraUrl, {
    headers: secret ? { "x-hasura-admin-secret": secret } : {},
  });
}

async function fetchChainSlice(network: Network): Promise<ChainSlice | null> {
  if (!network.hasuraUrl) return null;
  const client = makeClient(network);

  let pools: Pool[];
  try {
    const res = await client.request<{ Pool: Pool[] }>({
      document: ALL_POOLS_WITH_HEALTH,
      variables: { chainId: network.chainId },
      signal: AbortSignal.timeout(5000),
    });
    pools = res.Pool ?? [];
  } catch {
    // Chain entirely unreachable — drop from aggregates rather than fail
    // the whole card.
    return null;
  }

  if (pools.length === 0) {
    return { network, pools, daily: [], rates: new Map() };
  }

  let daily: PoolSnapshot[] = [];
  try {
    const res = await client.request<{ PoolDailySnapshot: PoolSnapshot[] }>({
      document: HOMEPAGE_OG_DAILY_SNAPSHOTS,
      variables: { poolIds: pools.map((p) => p.id) },
      signal: AbortSignal.timeout(5000),
    });
    const cutoff = Math.floor(Date.now() / 1000) - FOURTEEN_DAYS;
    daily = (res.PoolDailySnapshot ?? []).filter(
      (s) => Number(s.timestamp) >= cutoff,
    );
  } catch {
    // Pools + rates still usable for TVL / health — volume tiles will "—".
  }

  return { network, pools, daily, rates: buildOracleRateMap(pools, network) };
}

export async function fetchHomepageOgDataUncached(): Promise<HomepageOgData | null> {
  const configuredChains = NETWORK_IDS.map((id) => NETWORKS[id]).filter(
    (n) => n.hasuraUrl && !n.local && !n.testnet,
  );
  if (configuredChains.length === 0) return null;

  const slices = (
    await Promise.all(configuredChains.map(fetchChainSlice))
  ).filter((s): s is ChainSlice => s !== null);
  if (slices.length === 0) return null;

  // Virtual pools have no reserves — skip TVL/volume math, count toward
  // health buckets only.
  const fpmmEntries = slices.flatMap((s) =>
    s.pools.filter(isFpmm).map((pool) => ({ pool, slice: s })),
  );
  const priceable = fpmmEntries.filter(({ pool, slice }) =>
    canValueTvl(pool, slice.network, slice.rates),
  );

  const totalTvlUsd =
    priceable.length === 0
      ? null
      : priceable.reduce(
          (acc, { pool, slice }) =>
            acc + poolTvlUSD(pool, slice.network, slice.rates),
          0,
        );

  // TVL WoW: compare current vs 7d-ago reserves, restricted to pools with a
  // snapshot in [now-14d, now-7d] (matches pool-card bounded-window rule).
  const now = Math.floor(Date.now() / 1000);
  const upperCutoff = now - SEVEN_DAYS;
  const lowerCutoff = now - FOURTEEN_DAYS;
  let priorTvlSum = 0;
  let currentSubsetSum = 0;
  let anyPrior = false;
  for (const { pool, slice } of priceable) {
    const agoRow = slice.daily.find((d) => {
      if (d.poolId !== pool.id) return false;
      const ts = Number(d.timestamp);
      return ts <= upperCutoff && ts >= lowerCutoff;
    });
    if (!agoRow) continue;
    const agoTvl = poolTvlUSD(
      { ...pool, reserves0: agoRow.reserves0, reserves1: agoRow.reserves1 },
      slice.network,
      slice.rates,
    );
    if (agoTvl <= 0) continue;
    priorTvlSum += agoTvl;
    currentSubsetSum += poolTvlUSD(pool, slice.network, slice.rates);
    anyPrior = true;
  }
  const tvlWoWPct =
    anyPrior && priorTvlSum > 0
      ? ((currentSubsetSum - priorTvlSum) / priorTvlSum) * 100
      : null;

  const totalVolume7dUsd = sumVolumeInWindow(priceable, now - SEVEN_DAYS, now);
  const priorVolume = sumVolumeInWindow(
    priceable,
    now - FOURTEEN_DAYS,
    now - SEVEN_DAYS,
  );
  const volume7dWoWPct =
    totalVolume7dUsd != null && priorVolume != null && priorVolume > 0
      ? ((totalVolume7dUsd - priorVolume) / priorVolume) * 100
      : null;

  const volumeSeries = computeDailyVolumeSeries(priceable);
  const tvlSeries = computeDailyTvlSeries(priceable);

  // Health buckets across ALL pools (virtual = N/A, excluded from TVL).
  const healthBuckets: Record<HealthStatus, number> = {
    OK: 0,
    WARN: 0,
    CRITICAL: 0,
    WEEKEND: 0,
    "N/A": 0,
  };
  const attentionPools: AttentionPool[] = [];
  for (const slice of slices) {
    for (const pool of slice.pools) {
      const status = computeEffectiveStatus(pool, slice.network.chainId);
      healthBuckets[status] = (healthBuckets[status] ?? 0) + 1;
      if (status === "WARN" || status === "CRITICAL") {
        attentionPools.push({
          name: poolName(
            slice.network,
            pool.token0 ?? null,
            pool.token1 ?? null,
          ),
          chainLabel: slice.network.label,
          health: status,
        });
      }
    }
  }
  // CRITICAL first, then WARN, each alphabetical.
  attentionPools.sort((a, b) => {
    if (a.health !== b.health) return a.health === "CRITICAL" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const poolCount = slices.reduce((n, s) => n + s.pools.length, 0);

  return {
    totalTvlUsd,
    tvlWoWPct,
    totalVolume7dUsd,
    volume7dWoWPct,
    volumeSeries,
    tvlSeries,
    poolCount,
    chainCount: slices.length,
    chains: slices.map((s) => s.network.label),
    healthBuckets,
    attentionPools: attentionPools.slice(0, MAX_ATTENTION_POOLS),
  };
}

type PriceableEntry = { pool: Pool; slice: ChainSlice };

function rowUsdVolume(
  row: PoolSnapshot,
  pool: Pool,
  slice: ChainSlice,
): number {
  const sym0 = tokenSymbol(slice.network, pool.token0 ?? null);
  const sym1 = tokenSymbol(slice.network, pool.token1 ?? null);
  const d0 = pool.token0Decimals ?? 18;
  const d1 = pool.token1Decimals ?? 18;
  const v0 = parseWei(row.swapVolume0 ?? "0", d0);
  const v1 = parseWei(row.swapVolume1 ?? "0", d1);
  if (USDM_SYMBOLS.has(sym0)) return v0;
  if (USDM_SYMBOLS.has(sym1)) return v1;
  const u0 = tokenToUSD(sym0, v0, slice.rates);
  if (u0 !== null) return u0;
  const u1 = tokenToUSD(sym1, v1, slice.rates);
  return u1 ?? 0;
}

function sumVolumeInWindow(
  entries: PriceableEntry[],
  fromSec: number,
  toSec: number,
): number | null {
  let sum = 0;
  let any = false;
  for (const { pool, slice } of entries) {
    for (const row of slice.daily) {
      if (row.poolId !== pool.id) continue;
      const ts = Number(row.timestamp);
      if (ts < fromSec || ts >= toSec) continue;
      sum += rowUsdVolume(row, pool, slice);
      any = true;
    }
  }
  return any ? sum : null;
}

// Per-day aggregate USD volume across all priceable pools, chronological.
// Days without any snapshot are omitted — better to show a shorter line
// than invent carry-forward values.
function computeDailyVolumeSeries(entries: PriceableEntry[]): number[] {
  const perDay = new Map<number, number>();
  for (const { pool, slice } of entries) {
    for (const row of slice.daily) {
      if (row.poolId !== pool.id) continue;
      const ts = Number(row.timestamp);
      perDay.set(ts, (perDay.get(ts) ?? 0) + rowUsdVolume(row, pool, slice));
    }
  }
  const days = Array.from(perDay.keys()).sort((a, b) => a - b);
  return days.slice(-SPARKLINE_DAYS).map((d) => perDay.get(d) ?? 0);
}

// Per-day aggregate TVL across priceable pools. For each daily snapshot
// row, compute that pool's TVL using the row's reserves × current oracle
// rates (same approximation the main TVL chart in pool-tvl-over-time-chart
// makes — historical oracle prices aren't reconstructed). Pools without
// a snapshot for a given day simply don't contribute to that day's sum.
function computeDailyTvlSeries(entries: PriceableEntry[]): number[] {
  const perDay = new Map<number, number>();
  for (const { pool, slice } of entries) {
    for (const row of slice.daily) {
      if (row.poolId !== pool.id) continue;
      const ts = Number(row.timestamp);
      const tvl = poolTvlUSD(
        { ...pool, reserves0: row.reserves0, reserves1: row.reserves1 },
        slice.network,
        slice.rates,
      );
      perDay.set(ts, (perDay.get(ts) ?? 0) + tvl);
    }
  }
  const days = Array.from(perDay.keys()).sort((a, b) => a - b);
  return days.slice(-SPARKLINE_DAYS).map((d) => perDay.get(d) ?? 0);
}

// 60s TTL — pool health / attention counts change during incidents; a
// long cache would leave stale counts in shared previews.
const cachedFetch = unstable_cache(
  fetchHomepageOgDataUncached,
  ["homepage-og"],
  { revalidate: 60, tags: ["homepage-og"] },
);

export function fetchHomepageOgData(): Promise<HomepageOgData | null> {
  return cachedFetch();
}
