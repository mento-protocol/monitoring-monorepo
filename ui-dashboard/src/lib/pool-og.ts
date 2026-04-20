import { unstable_cache } from "next/cache";
import { GraphQLClient } from "graphql-request";
import { isNamespacedPoolId, extractChainIdFromPoolId } from "@/lib/pool-id";
import { NETWORKS, networkIdForChainId, type Network } from "@/lib/networks";
import {
  buildOracleRateMap,
  canValueTvl,
  poolName,
  poolTvlUSD,
  tokenSymbol,
  tokenToUSD,
  USDM_SYMBOLS,
  type OracleRateMap,
} from "@/lib/tokens";
import {
  computeEffectiveStatus,
  isOracleFresh,
  type HealthStatus,
} from "@/lib/health";
import { ALL_POOLS_WITH_HEALTH, POOL_DETAIL_WITH_HEALTH } from "@/lib/queries";
import { parseWei } from "@/lib/format";
import type { Pool, PoolSnapshot } from "@/lib/types";

// Lean, OG-specific daily snapshot query. Only pulls the fields and row count
// needed for the sparkline + 7d WoW — a fraction of POOL_DAILY_SNAPSHOTS_CHART's
// payload. Ordered newest-first; 14 rows covers both the 14-point sparkline
// and the ~7d-ago row for WoW.
const POOL_OG_DAILY_SNAPSHOTS = `
  query PoolOgDailySnapshots($poolId: String!) {
    PoolDailySnapshot(
      where: { poolId: { _eq: $poolId } }
      order_by: [{ timestamp: desc }, { id: desc }]
      limit: 14
    ) {
      timestamp
      reserves0
      reserves1
      swapVolume0
      swapVolume1
    }
  }
`;

const SECONDS_PER_DAY = 86_400;
const SEVEN_DAYS = 7 * SECONDS_PER_DAY;
const SPARKLINE_DAYS = 14;

export type PoolOgData = {
  name: string;
  chainLabel: string;
  tokenSymbols: [string, string];
  tvlUsd: number;
  tvlWoWPct: number | null;
  volume7dUsd: number | null;
  health: HealthStatus;
  /** Chronological TVL series (oldest→newest), up to 14 daily points. */
  tvlSeries: number[];
  /** Seconds since last oracle update; null for virtual pools / missing data. */
  oracleAgeSeconds: number | null;
  /** Whether the oracle is within its configured expiry window. */
  oracleFresh: boolean;
};

function makeClient(network: Network): GraphQLClient {
  const secret = network.hasuraSecret.trim();
  return new GraphQLClient(network.hasuraUrl, {
    headers: secret ? { "x-hasura-admin-secret": secret } : {},
  });
}

// Only namespaced `{chainId}-0x...` IDs are supported. Bare 0x addresses
// would need cross-network probing here, but the pool page at
// app/pool/[poolId]/page.tsx normalizes bare addresses against
// DEFAULT_NETWORK only and redirects on miss — probing in this route would
// make OG previews point to a chain the page won't load. All canonical
// URLs from buildPoolDetailHref are namespaced anyway.
function resolvePoolId(
  rawPoolId: string,
): { poolId: string; chainId: number } | null {
  if (!isNamespacedPoolId(rawPoolId)) return null;
  const chainId = extractChainIdFromPoolId(rawPoolId);
  if (chainId === null) return null;
  return { poolId: rawPoolId.toLowerCase(), chainId };
}

/** @internal Exported for testing — skip the cache wrapper. */
export async function fetchPoolOgDataUncached(
  rawPoolId: string,
): Promise<PoolOgData | null> {
  const resolved = resolvePoolId(rawPoolId);
  if (!resolved) return null;
  const { poolId, chainId } = resolved;

  const networkId = networkIdForChainId(chainId);
  if (!networkId) return null;
  const network = NETWORKS[networkId];
  if (!network.hasuraUrl) return null;

  const client = makeClient(network);

  // Fail-open: only the detail query is load-bearing. If daily snapshots or
  // the all-pools rate-map query transiently fail, still render a card with
  // real title/chain/health — degraded cards beat generic ones, and a hard
  // fail here would be cached for an hour by unstable_cache below.
  const [detailResult, dailyResult, allPoolsResult] = await Promise.allSettled([
    client.request<{ Pool: Pool[] }>(POOL_DETAIL_WITH_HEALTH, {
      id: poolId,
      chainId,
    }),
    client.request<{ PoolDailySnapshot: PoolSnapshot[] }>(
      POOL_OG_DAILY_SNAPSHOTS,
      { poolId },
    ),
    client.request<{ Pool: Pool[] }>(ALL_POOLS_WITH_HEALTH, { chainId }),
  ]);

  if (detailResult.status !== "fulfilled") return null;
  const pool = detailResult.value.Pool[0];
  if (!pool) return null;

  const dailyRows =
    dailyResult.status === "fulfilled"
      ? (dailyResult.value.PoolDailySnapshot ?? [])
      : [];
  const allPools =
    allPoolsResult.status === "fulfilled"
      ? (allPoolsResult.value.Pool ?? [])
      : [];

  const rates = buildOracleRateMap(allPools, network);
  const t0 = pool.token0 ?? null;
  const t1 = pool.token1 ?? null;
  const sym0 = tokenSymbol(network, t0);
  const sym1 = tokenSymbol(network, t1);

  // For FX/FX pools that need the rate map to price TVL, a failed
  // ALL_POOLS_WITH_HEALTH query leaves `rates` empty and poolTvlUSD silently
  // returns 0. Suppress TVL-derived fields rather than ship fake zeros.
  const priceable = canValueTvl(pool, network, rates);
  const tvlUsd = priceable ? poolTvlUSD(pool, network, rates) : 0;
  const volume7dUsd = priceable
    ? computeVolume7d(dailyRows, sym0, sym1, pool, rates)
    : null;
  const tvlWoWPct = priceable
    ? computeTvlWoW(tvlUsd, dailyRows, pool, network, rates)
    : null;
  const tvlSeries = priceable
    ? computeTvlSeries(dailyRows, pool, network, rates)
    : [];
  const oracle = computeOracleFreshness(pool, chainId);

  return {
    name: poolName(network, t0, t1),
    chainLabel: network.label,
    tokenSymbols: [sym0, sym1],
    tvlUsd,
    tvlWoWPct,
    volume7dUsd,
    health: computeEffectiveStatus(pool, chainId),
    tvlSeries,
    oracleAgeSeconds: oracle.ageSeconds,
    oracleFresh: oracle.fresh,
  };
}

function computeVolume7d(
  daily: PoolSnapshot[],
  sym0: string,
  sym1: string,
  pool: Pool,
  rates: OracleRateMap,
): number | null {
  if (daily.length === 0) return null;
  const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS;
  const recent = daily.filter((s) => Number(s.timestamp) >= cutoff);
  if (recent.length === 0) return null;

  const d0 = pool.token0Decimals ?? 18;
  const d1 = pool.token1Decimals ?? 18;
  let sumUsd = 0;
  for (const row of recent) {
    const v0 = parseWei(row.swapVolume0 ?? "0", d0);
    const v1 = parseWei(row.swapVolume1 ?? "0", d1);
    if (USDM_SYMBOLS.has(sym0)) {
      sumUsd += v0;
    } else if (USDM_SYMBOLS.has(sym1)) {
      sumUsd += v1;
    } else {
      const u0 = tokenToUSD(sym0, v0, rates);
      const u1 = tokenToUSD(sym1, v1, rates);
      if (u0 !== null) sumUsd += u0;
      else if (u1 !== null) sumUsd += u1;
      else return null;
    }
  }
  return sumUsd;
}

function computeTvlWoW(
  tvlNow: number,
  daily: PoolSnapshot[],
  pool: Pool,
  network: Network,
  rates: OracleRateMap,
): number | null {
  if (tvlNow <= 0 || daily.length === 0) return null;
  // Bound the baseline to [now-14d, now-7d] — sparse daily histories (inactive
  // pools, backfill gaps) otherwise pick an arbitrarily-old snapshot and
  // mislabel e.g. a 30d delta as "7d". Matches tvlWoWChangePct in
  // pool-tvl-over-time-chart.tsx.
  const now = Math.floor(Date.now() / 1000);
  const upperCutoff = now - SEVEN_DAYS;
  const lowerCutoff = now - 14 * SECONDS_PER_DAY;
  const agoRow = daily.find((s) => {
    const ts = Number(s.timestamp);
    return ts <= upperCutoff && ts >= lowerCutoff;
  });
  if (!agoRow) return null;

  const tvlAgo = poolTvlUSD(
    { ...pool, reserves0: agoRow.reserves0, reserves1: agoRow.reserves1 },
    network,
    rates,
  );
  if (tvlAgo <= 0) return null;
  return ((tvlNow - tvlAgo) / tvlAgo) * 100;
}

function computeTvlSeries(
  daily: PoolSnapshot[],
  pool: Pool,
  network: Network,
  rates: OracleRateMap,
): number[] {
  // Daily rows arrive newest-first; take up to 14 and reverse to chronological.
  const slice = daily.slice(0, SPARKLINE_DAYS).reverse();
  return slice.map((row) =>
    poolTvlUSD(
      { ...pool, reserves0: row.reserves0, reserves1: row.reserves1 },
      network,
      rates,
    ),
  );
}

function computeOracleFreshness(
  pool: Pool,
  chainId: number,
): { ageSeconds: number | null; fresh: boolean } {
  const oracleTs = Number(pool.oracleTimestamp ?? "0");
  if (!oracleTs || pool.source?.includes("virtual")) {
    return { ageSeconds: null, fresh: false };
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    ageSeconds: now - oracleTs,
    fresh: isOracleFresh(pool, now, chainId),
  };
}

const cachedFetch = unstable_cache(fetchPoolOgDataUncached, ["pool-og"], {
  revalidate: 3600,
  tags: ["pool-og"],
});

export function fetchPoolForMetadata(
  rawPoolId: string,
): Promise<PoolOgData | null> {
  return cachedFetch(rawPoolId);
}
