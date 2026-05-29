import { unstable_cache } from "next/cache";
import { isNamespacedPoolId, extractChainIdFromPoolId } from "@/lib/pool-id";
import { NETWORKS, networkIdForChainId, type Network } from "@/lib/networks";
import { makeOgGraphQLClient } from "@/lib/og-graphql-client";
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
  computeHealthStatus,
  isOracleFresh,
  type HealthStatus,
} from "@/lib/health";
import { isWeekend } from "@/lib/weekend";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import {
  ALL_POOLS_WITH_HEALTH,
  POOL_DETAIL_WITH_HEALTH,
  POOL_THRESHOLDS_KNOWN_EXT,
} from "@/lib/queries";
import { parseWei } from "@/lib/format";
import { isVirtualPool, type Pool, type PoolSnapshot } from "@/lib/types";

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
  /** USD value of reserves; `null` = unpriceable (e.g. FX/FX pool without
   * rate map). `0` means the pool is genuinely empty. Collapse these into
   * "—" at the display layer if you want; don't conflate them in the data. */
  tvlUsd: number | null;
  tvlWoWPct: number | null;
  volume7dUsd: number | null;
  /** Week-over-week change in 7d volume (current 7d vs prior 7d). Null when
   * prior-week data is missing or the prior window was 0 (division undefined). */
  volume7dWoWPct: number | null;
  health: HealthStatus;
  /** Short reasons behind the current health — empty for OK/N/A/WEEKEND.
   * Mirrors the sub-parts that drive computeEffectiveStatus so the card
   * can answer "why needs attention?" without a second data fetch. */
  healthReasons: string[];
  /** Chronological TVL series (oldest→newest), up to 14 daily points. */
  tvlSeries: number[];
  /** Chronological daily USD volume series (oldest→newest), up to 14 points. */
  volumeSeries: number[];
  /** Seconds since last oracle update; null for virtual pools / missing data. */
  oracleAgeSeconds: number | null;
  /** Whether the oracle is within its configured expiry window. */
  oracleFresh: boolean;
};

// Only namespaced `{chainId}-0x...` IDs are supported. Bare 0x addresses
// require explicit route chain context before the page canonicalizes them;
// OG metadata receives only the path segment here, so previews stay
// namespaced-only rather than selecting a default chain the page might not
// load.
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

  const network = NETWORKS[networkIdForChainId(chainId)!];
  if (!network) return null;
  if (!network.hasuraUrl) return null;

  const client = makeOgGraphQLClient(network);

  // Per-request timeout. Without this, a hung upstream blocks allSettled until
  // Vercel's function timeout; 5s keeps crawler unfurls prompt on indexer issues.
  const signal = AbortSignal.timeout(HASURA_TIMEOUT_MS);

  // Fail-open: only the detail query is load-bearing. If daily snapshots or
  // the all-pools rate-map query transiently fail (including timeout), still
  // render a card with real title/chain/health — degraded cards beat generic
  // ones, and a hard fail here would be cached for an hour by unstable_cache.
  // Parallelizing all four (vs. await-detail-then-await-others) saves ~200ms
  // p50 on the success path. react-doctor's "skip-path stays fast"
  // optimization would only help if the detail query failed, which is < 1% of
  // calls — not worth the latency hit on the common case.
  // react-doctor-disable-next-line react-doctor/async-defer-await
  const [detailResult, dailyResult, allPoolsResult, thresholdsResult] =
    await Promise.allSettled([
      client.request<{ Pool: Pool[] }>({
        document: POOL_DETAIL_WITH_HEALTH,
        variables: { id: poolId, chainId },
        signal,
      }),
      client.request<{ PoolDailySnapshot: PoolSnapshot[] }>({
        document: POOL_OG_DAILY_SNAPSHOTS,
        variables: { poolId },
        signal,
      }),
      client.request<{ Pool: Pool[] }>({
        document: ALL_POOLS_WITH_HEALTH,
        variables: { chainId },
        signal,
      }),
      // Isolated trust / degenerate flags keep schema-lag from failing the
      // unfurl; health uses conservative WARN/CRITICAL under-bounds.
      client.request<{
        Pool: {
          id: string;
          rebalanceThresholdAbove?: number;
          rebalanceThresholdBelow?: number;
          rebalanceThresholdsKnown?: boolean;
          tokenDecimalsKnown?: boolean;
          degenerateReserves?: boolean;
        }[];
      }>({
        document: POOL_THRESHOLDS_KNOWN_EXT,
        variables: { id: poolId, chainId },
        signal,
      }),
    ]);

  if (detailResult.status !== "fulfilled") return null;
  const rawPool = detailResult.value.Pool[0];
  if (!rawPool) return null;
  let ext: PoolOgThresholdsExtRow | null = null;
  if (thresholdsResult.status === "fulfilled")
    ext = thresholdsResult.value.Pool[0] ?? null;
  const pool: Pool = ext
    ? {
        ...rawPool,
        rebalanceThresholdAbove: ext.rebalanceThresholdAbove,
        rebalanceThresholdBelow: ext.rebalanceThresholdBelow,
        rebalanceThresholdsKnown: ext.rebalanceThresholdsKnown,
        tokenDecimalsKnown: ext.tokenDecimalsKnown,
        degenerateReserves: ext.degenerateReserves,
      }
    : rawPool;

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
  // returns 0. Suppress TVL-derived fields (null, not 0) so consumers can
  // distinguish "unpriceable" from "genuinely empty pool".
  // `rawTvlUsd === null` also covers untrusted-decimals (poolTvlUSD now
  // returns null for those).
  const priceable = canValueTvl(pool, network, rates);
  const rawTvlUsd = priceable ? poolTvlUSD(pool, network, rates) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const volume7dUsd = priceable
    ? sumVolumeInWindow(
        dailyRows,
        sym0,
        sym1,
        pool,
        rates,
        nowSec - SEVEN_DAYS,
        nowSec,
      )
    : null;
  const priorVolume = priceable
    ? sumVolumeInWindow(
        dailyRows,
        sym0,
        sym1,
        pool,
        rates,
        nowSec - 2 * SEVEN_DAYS,
        nowSec - SEVEN_DAYS,
      )
    : null;
  const volume7dWoWPct =
    volume7dUsd != null && priorVolume != null && priorVolume > 0
      ? ((volume7dUsd - priorVolume) / priorVolume) * 100
      : null;
  const tvlWoWPct =
    priceable && rawTvlUsd !== null
      ? computeTvlWoW(rawTvlUsd, dailyRows, pool, network, rates)
      : null;
  const tvlSeries = priceable
    ? computeTvlSeries(dailyRows, pool, network, rates)
    : [];
  const volumeSeries = priceable
    ? computeVolumeSeries(dailyRows, sym0, sym1, pool, rates)
    : [];
  const oracle = computeOracleFreshness(pool, chainId);

  return {
    name: poolName(network, t0, t1),
    chainLabel: network.label,
    tokenSymbols: [sym0, sym1],
    tvlUsd: priceable ? rawTvlUsd : null,
    tvlWoWPct,
    volume7dUsd,
    volume7dWoWPct,
    health: computeEffectiveStatus(pool, chainId),
    healthReasons: computeHealthReasons(pool, chainId),
    tvlSeries,
    volumeSeries,
    oracleAgeSeconds: oracle.ageSeconds,
    oracleFresh: oracle.fresh,
  };
}

function computeVolumeSeries(
  daily: PoolSnapshot[],
  sym0: string,
  sym1: string,
  pool: Pool,
  rates: OracleRateMap,
): number[] {
  // Same untrusted-decimals defense as the other valuation paths —
  // `pool.tokenDecimalsKnown !== true` means USD math against schema-default
  // 18/18 would overstate by ~1e12 for a 6-dp leg. Empty series renders
  // as "—" in the OG card. Strict gate (PR 1.7): undefined fails closed
  // since the post-PR-1.6 indexer populates the field on every pool.
  if (pool.tokenDecimalsKnown !== true) return [];
  const slice = daily.slice(0, SPARKLINE_DAYS).reverse();
  const d0 = pool.token0Decimals ?? 18;
  const d1 = pool.token1Decimals ?? 18;
  return slice.map((row) => {
    const v0 = parseWei(row.swapVolume0 ?? "0", d0);
    const v1 = parseWei(row.swapVolume1 ?? "0", d1);
    if (USDM_SYMBOLS.has(sym0)) return v0;
    if (USDM_SYMBOLS.has(sym1)) return v1;
    const u0 = tokenToUSD(sym0, v0, rates);
    if (u0 !== null) return u0;
    const u1 = tokenToUSD(sym1, v1, rates);
    return u1 ?? 0;
  });
}

// Severity ranks for reason sorting — mirrors STATUS_RANK in health.ts
// (WARN=2, CRITICAL=4). Reasons are emitted worst-first so the tile
// subline's first entry matches the dominant effective status.
const REASON_WARN = 2;
const REASON_CRITICAL = 4;

/** Enumerate the specific sub-issues driving a pool's effective health.
 * Returns [] for healthy / virtual / WEEKEND pools (the "Markets closed"
 * label is already the full story — stacking reasons contradicts it).
 * Each reason is a short lowercase phrase suitable for display in meta
 * descriptions and card sublines, sorted by severity descending. */
function computeHealthReasons(pool: Pool, chainId: number): string[] {
  if (isVirtualPool(pool)) return [];
  if (computeEffectiveStatus(pool, chainId) === "WEEKEND") return [];

  const items: { text: string; severity: number }[] = [];
  const now = Math.floor(Date.now() / 1000);

  if (!isOracleFresh(pool, now, chainId)) {
    // Oracle staleness during FX weekends is expected market closure, not
    // an incident. Guard on isWeekend() even when effective status bumped
    // to CRITICAL via limits — otherwise "oracle stale" would outrank the
    // real trigger ("trading limits breached") in the severity sort.
    if (!isWeekend()) {
      items.push({ text: "oracle stale", severity: REASON_CRITICAL });
    }
  } else {
    // Delegate the deviation tier branching to the same function the rest of
    // the app uses, so OG cards can never disagree with the on-page badge.
    // Oracle is fresh in this branch, so computeHealthStatus only returns
    // OK / WARN / CRITICAL based on the tolerance + critical-magnitude gates.
    const status = computeHealthStatus(pool, chainId, now);
    if (status === "WARN")
      items.push({ text: "rebalance in flight", severity: REASON_WARN });
    else if (status === "CRITICAL")
      items.push({ text: "price deviation breach", severity: REASON_CRITICAL });
  }

  const p0 = Number(pool.limitPressure0 ?? "0");
  const p1 = Number(pool.limitPressure1 ?? "0");
  const maxPressure = Math.max(p0, p1);
  if (maxPressure >= 1.0) {
    items.push({ text: "trading limits breached", severity: REASON_CRITICAL });
  } else if (maxPressure >= 0.8) {
    items.push({ text: "trading limits near cap", severity: REASON_WARN });
  }

  return items.sort((a, b) => b.severity - a.severity).map((r) => r.text);
}

// Sum daily USD volume for rows whose timestamp falls in [fromSec, toSec).
// Used for both the current 7d total and the prior-7d baseline that drives
// the volume WoW percentage.
function sumVolumeInWindow(
  daily: PoolSnapshot[],
  sym0: string,
  sym1: string,
  pool: Pool,
  rates: OracleRateMap,
  fromSec: number,
  toSec: number,
): number | null {
  // Untrusted-decimals defense — see computeVolumeSeries for rationale.
  if (pool.tokenDecimalsKnown !== true) return null;
  const rows = daily.filter((s) => {
    const ts = Number(s.timestamp);
    return ts >= fromSec && ts < toSec;
  });
  if (rows.length === 0) return null;

  const d0 = pool.token0Decimals ?? 18;
  const d1 = pool.token1Decimals ?? 18;
  let sumUsd = 0;
  for (const row of rows) {
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
  // mislabel e.g. a 30d delta as "7d". Matches stockWoWChangePct in
  // lib/time-series.ts.
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
  if (tvlAgo === null || tvlAgo <= 0) return null;
  return ((tvlNow - tvlAgo) / tvlAgo) * 100;
}

function computeTvlSeries(
  daily: PoolSnapshot[],
  pool: Pool,
  network: Network,
  rates: OracleRateMap,
): number[] {
  // Daily rows arrive newest-first; take up to 14 and reverse to chronological.
  // Skip rows where TVL is unknowable (untrusted decimals → null) — the
  // sparkline shows what we can compute and gaps are honest about gaps.
  const slice = daily.slice(0, SPARKLINE_DAYS).reverse();
  const series: number[] = [];
  for (const row of slice) {
    const v = poolTvlUSD(
      { ...pool, reserves0: row.reserves0, reserves1: row.reserves1 },
      network,
      rates,
    );
    if (v !== null) series.push(v);
  }
  return series;
}

function computeOracleFreshness(
  pool: Pool,
  chainId: number,
): { ageSeconds: number | null; fresh: boolean } {
  const oracleTs = Number(pool.oracleTimestamp ?? "0");
  if (!oracleTs || isVirtualPool(pool)) {
    return { ageSeconds: null, fresh: false };
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    ageSeconds: now - oracleTs,
    fresh: isOracleFresh(pool, now, chainId),
  };
}

type PoolOgThresholdsExtRow = {
  id: string;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
  tokenDecimalsKnown?: boolean;
  degenerateReserves?: boolean;
};

// 60s TTL — pool health can flip during an incident; a 1h cache meant a
// link re-shared during rebalance showed stale "Critical" for an hour.
// 60s gives fresh state on each new unfurl while still batching repeated
// requests (generateMetadata + generateImageMetadata + Image within one
// server request all dedupe here).
const cachedFetch = unstable_cache(fetchPoolOgDataUncached, ["pool-og"], {
  revalidate: 60,
  tags: ["pool-og"],
});

export function fetchPoolForMetadata(
  rawPoolId: string,
): Promise<PoolOgData | null> {
  return cachedFetch(rawPoolId);
}
