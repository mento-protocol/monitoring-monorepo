import { unstable_cache } from "next/cache";
import { NETWORKS, NETWORK_IDS, type Network } from "@/lib/networks";
import { makeOgGraphQLClient } from "@/lib/og-graphql-client";
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
import { ALL_POOLS_WITH_HEALTH, POOL_DAILY_SNAPSHOTS_ALL } from "@/lib/queries";
import { parseWei } from "@/lib/format";
import type { Pool, PoolSnapshot } from "@/lib/types";

const SECONDS_PER_DAY = 86_400;
const SEVEN_DAYS = 7 * SECONDS_PER_DAY;
const FOURTEEN_DAYS = 14 * SECONDS_PER_DAY;
// Matches the homepage's default TVL-chart range ("1M" / 30d) so the OG
// preview line shape agrees with what users see when they open the app.
const TVL_CHART_DAYS = 30;
const VOLUME_SPARKLINE_DAYS = 14;
const MAX_ATTENTION_POOLS = 3;
// Pagination settings for the daily-snapshot fetch. Hasura silently caps
// at 1000 rows, so we page until a response comes back short. SAFETY_CAP
// bounds total work at ~5000 rows per chain (plenty for years of history
// across any realistic pool count).
const DAILY_PAGE_SIZE = 1000;
const DAILY_MAX_PAGES = 5;

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
  /** Chronological daily aggregate TVL, oldest→newest, 30 points ending
   * on today's UTC day (matches the dashboard's default "1M" range).
   * Forward-filled per pool: each bucket sums each pool's
   * most-recent-snapshot TVL at-or-before that bucket timestamp. */
  tvlSeries: number[];
  poolCount: number;
  chainCount: number;
  chains: string[];
  healthBuckets: Record<HealthStatus, number>;
  /** Pools in WARN/CRITICAL state, highest severity first, up to 3. */
  attentionPools: AttentionPool[];
  /** True when at least one configured chain's pool query failed. All
   * protocol-wide aggregates in this payload reflect only the chains in
   * `chains` — consumers must label them accordingly or the card
   * silently under-reports the protocol during an outage. */
  partial: boolean;
  /** Labels of configured mainnet chains currently offline / excluded. */
  offlineChains: string[];
};

type ChainSlice = {
  network: Network;
  pools: Pool[];
  daily: PoolSnapshot[];
  rates: OracleRateMap;
  /** True if the daily-snapshot fetch for this chain failed or hit the
   * safety cap mid-pagination. Signals cross-chain daily-derived
   * aggregates (volume, tvl-series) can't be trusted for protocol totals. */
  dailyDegraded: boolean;
};

async function fetchChainSlice(network: Network): Promise<ChainSlice | null> {
  if (!network.hasuraUrl) return null;
  const client = makeOgGraphQLClient(network);

  let pools: Pool[];
  try {
    const res = await client.request<{ Pool: Pool[] }>({
      document: ALL_POOLS_WITH_HEALTH,
      variables: { chainId: network.chainId },
      signal: AbortSignal.timeout(5000),
    });
    pools = res.Pool ?? [];
  } catch {
    // Chain pool query failed entirely — treat as offline. Aggregator
    // will surface this via `partial` / `offlineChains`.
    return null;
  }

  if (pools.length === 0) {
    return {
      network,
      pools,
      daily: [],
      rates: new Map(),
      dailyDegraded: false,
    };
  }

  // Paginate daily snapshots via POOL_DAILY_SNAPSHOTS_ALL (1000-row
  // Hasura cap). Without pagination the OG card self-disables at normal
  // growth (≈30 pools × 35 days = 1050 rows on one chain).
  const poolIds = pools.map((p) => p.id);
  const seen = new Set<string>();
  const daily: PoolSnapshot[] = [];
  let dailyDegraded = false;
  try {
    for (let page = 0; page < DAILY_MAX_PAGES; page++) {
      const res = await client.request<{ PoolDailySnapshot: PoolSnapshot[] }>({
        document: POOL_DAILY_SNAPSHOTS_ALL,
        variables: {
          poolIds,
          limit: DAILY_PAGE_SIZE,
          offset: page * DAILY_PAGE_SIZE,
        },
        signal: AbortSignal.timeout(5000),
      });
      const rows = res.PoolDailySnapshot ?? [];
      for (const row of rows) {
        const key = `${row.poolId}:${row.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        daily.push(row);
      }
      if (rows.length < DAILY_PAGE_SIZE) break;
      // Still full at last attempt means we may have truncated — flag it.
      if (page === DAILY_MAX_PAGES - 1) dailyDegraded = true;
    }
  } catch {
    // Daily query failed mid-pagination; mark degraded so the aggregator
    // nulls out the cross-chain daily-derived fields.
    dailyDegraded = true;
  }

  return {
    network,
    pools,
    daily,
    rates: buildOracleRateMap(pools, network),
    dailyDegraded,
  };
}

export async function fetchHomepageOgDataUncached(): Promise<HomepageOgData | null> {
  const configuredChains = NETWORK_IDS.map((id) => NETWORKS[id]).filter(
    (n) => n.hasuraUrl && !n.local && !n.testnet,
  );
  if (configuredChains.length === 0) return null;

  const sliceResults = await Promise.all(
    configuredChains.map(async (network) => ({
      network,
      slice: await fetchChainSlice(network),
    })),
  );
  // Track chains whose pool query failed entirely so consumers can surface
  // "partial overview" rather than ship surviving-chain numbers as complete.
  const offlineChains = sliceResults
    .filter((r) => r.slice === null)
    .map((r) => r.network.label);
  const slices = sliceResults
    .map((r) => r.slice)
    .filter((s): s is ChainSlice => s !== null);
  if (slices.length === 0) return null;
  const partial = offlineChains.length > 0;

  // TVL aggregation uses only FPMM pools with a live oracle price —
  // VirtualPools have no reserves and can't be TVL-counted. `canValueTvl`
  // already requires `oraclePrice`, so virtual and oracle-stale pools
  // drop out here.
  const fpmmEntries = slices.flatMap((s) =>
    s.pools.filter(isFpmm).map((pool) => ({ pool, slice: s })),
  );
  const priceable = fpmmEntries.filter(({ pool, slice }) =>
    canValueTvl(pool, slice.network, slice.rates),
  );
  // Volume aggregation includes ALL pools (FPMM + VirtualPool) so the OG
  // preview matches the dashboard's protocol volume total, which also
  // counts VirtualPool swaps (see components/volume-over-time-chart.tsx).
  const allEntries = slices.flatMap((s) =>
    s.pools.map((pool) => ({ pool, slice: s })),
  );

  const totalTvlUsd =
    priceable.length === 0
      ? null
      : priceable.reduce(
          (acc, { pool, slice }) =>
            acc + poolTvlUSD(pool, slice.network, slice.rates),
          0,
        );

  const now = Math.floor(Date.now() / 1000);
  // If any chain's daily-snapshot fetch failed or truncated, the cross-chain
  // daily-derived totals would silently undercount — surviving chains'
  // data labeled as "protocol-wide". Null everything daily-derived and let
  // the card fall back to "—" rather than ship dishonest numbers.
  const anyChainDegraded = slices.some((s) => s.dailyDegraded);

  // TVL WoW: compare current vs 7d-ago reserves, restricted to pools with a
  // snapshot in [now-14d, now-7d] (matches pool-card bounded-window rule).
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
    !anyChainDegraded && anyPrior && priorTvlSum > 0
      ? ((currentSubsetSum - priorTvlSum) / priorTvlSum) * 100
      : null;

  const totalVolume7dUsd = anyChainDegraded
    ? null
    : sumVolumeInWindow(allEntries, now - SEVEN_DAYS, now);
  const priorVolume = anyChainDegraded
    ? null
    : sumVolumeInWindow(allEntries, now - FOURTEEN_DAYS, now - SEVEN_DAYS);
  const volume7dWoWPct =
    totalVolume7dUsd != null && priorVolume != null && priorVolume > 0
      ? ((totalVolume7dUsd - priorVolume) / priorVolume) * 100
      : null;

  const volumeSeries = anyChainDegraded
    ? []
    : computeDailyVolumeSeries(allEntries);
  const tvlSeries = anyChainDegraded ? [] : computeDailyTvlSeries(priceable);

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
    partial,
    offlineChains,
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
  return days.slice(-VOLUME_SPARKLINE_DAYS).map((d) => perDay.get(d) ?? 0);
}

// Forward-filled per-day aggregate TVL across priceable pools, clamped
// to the last SPARKLINE_DAYS buckets. Mirrors `buildDailySeries` in
// components/tvl-over-time-chart.tsx: per pool, advance a cursor to the
// most recent snapshot at-or-before each bucket timestamp; sum across
// pools. Without forward-fill, pools without a snapshot on a given day
// contribute 0 and the aggregate zigzags based on which pools happened
// to tick that day — the line chart on the homepage doesn't agree with
// any real trend.
function computeDailyTvlSeries(entries: PriceableEntry[]): number[] {
  type History = {
    pool: Pool;
    slice: ChainSlice;
    points: Array<{ ts: number; r0: string; r1: string }>;
  };
  const histories: History[] = [];
  for (const { pool, slice } of entries) {
    const points = slice.daily
      .filter((d) => d.poolId === pool.id)
      .map((d) => ({
        ts: Number(d.timestamp),
        r0: d.reserves0,
        r1: d.reserves1,
      }))
      .sort((a, b) => a.ts - b.ts);
    if (points.length > 0) histories.push({ pool, slice, points });
  }
  if (histories.length === 0) return [];

  const now = Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  // Emit exactly TVL_CHART_DAYS buckets ending on today's UTC day.
  const windowStartBucket = endBucket - (TVL_CHART_DAYS - 1) * SECONDS_PER_DAY;

  const cursors = new Array<number>(histories.length).fill(-1);
  const series: number[] = [];
  for (let ts = windowStartBucket; ts <= endBucket; ts += SECONDS_PER_DAY) {
    let tvl = 0;
    for (let i = 0; i < histories.length; i++) {
      const h = histories[i];
      while (
        cursors[i] + 1 < h.points.length &&
        h.points[cursors[i] + 1].ts < ts + SECONDS_PER_DAY
      ) {
        cursors[i]++;
      }
      if (cursors[i] < 0) continue;
      const point = h.points[cursors[i]];
      tvl += poolTvlUSD(
        { ...h.pool, reserves0: point.r0, reserves1: point.r1 },
        h.slice.network,
        h.slice.rates,
      );
    }
    series.push(tvl);
  }
  return series;
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
