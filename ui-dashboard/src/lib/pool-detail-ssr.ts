// Server-only by convention (like lib/pool-og.ts): imported exclusively from the
// `/pool/[poolId]` Server Component, and it pulls in no client-only modules
// (`useSWR`/`useNetwork`/`next-auth`). Deliberately NOT using `import "server-only"`
// — that guard throws under the (non-RSC) vitest environment that transitively
// imports this via page.tsx, exactly as pool-og.ts avoids it.
import { unstable_cache } from "next/cache";
import { makeOgGraphQLClient } from "@/lib/og-graphql-client";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import type { PoolDetailInitialData } from "@/lib/pool-detail-initial-data";
import {
  BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H,
  type BrokerExchangeDailySnapshots24hResponse,
} from "@/lib/queries/broker";
import {
  POOL_BREAKER_CONFIG,
  type PoolBreakerConfigResponse,
} from "@/lib/queries/config";
import {
  POOL_DETAIL_WITH_HEALTH,
  POOL_THRESHOLDS_KNOWN_EXT,
  POOL_V2_EXCHANGE,
  POOL_VP_DEPRECATION_EXT,
  POOL_VP_LIFECYCLE_DEPRECATION_EXT,
  POOL_VP_ORACLE_FRESHNESS_EXT,
  type PoolDetailResponse,
  type PoolThresholdsKnownExtResponse,
  type PoolV2ExchangeResponse,
  type PoolVpDeprecationExtResponse,
  type PoolVpLifecycleDeprecationExtResponse,
  type PoolVpOracleFreshnessExtResponse,
} from "@/lib/queries/pool-detail";
import { NETWORKS, configuredNetworkIdForChainId } from "@/lib/networks";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { isVirtualPool, type Pool } from "@/lib/types";

// SSR-prefetch of the pool-detail base row plus split extension queries.
// `/pool/[poolId]` is otherwise a pure client waterfall: PoolOverview swaps a
// short skeleton for a tall header + health block once the client fetch resolves,
// which is the measured CLS 0.25. Fetching the same query variables server-side
// and handing the responses to the client as fallbackData lets the overview and
// extension-backed tiles paint immediately, eliminating that shift.
//
// Distinct from lib/pool-og.ts: that fetch merges extensions and returns a
// transformed PoolOgData shape for OG images; this returns the raw responses.
function currentUtcDayStartSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

type PoolDetailClient = ReturnType<typeof makeOgGraphQLClient>;

async function requestOptional<T>(
  client: PoolDetailClient,
  document: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T | undefined> {
  try {
    return await client.request<T>({
      document,
      variables,
      signal,
    });
  } catch {
    return undefined;
  }
}

async function fetchVirtualPoolHeaderInitialData(
  client: PoolDetailClient,
  chainId: number,
  pool: Pool,
  signal: AbortSignal,
): Promise<Pick<PoolDetailInitialData, "v2Exchange" | "brokerExchange24h">> {
  if (!isVirtualPool(pool)) return {};
  const v2Exchange = await requestOptional<PoolV2ExchangeResponse>(
    client,
    POOL_V2_EXCHANGE,
    { poolId: pool.id, chainId },
    signal,
  );
  const v2Config = v2Exchange?.BiPoolExchange?.[0];
  const exchangeId = (pool.wrappedExchangeId ?? v2Config?.exchangeId ?? "")
    .toLowerCase()
    .trim();
  const exchangeProvider = (v2Config?.exchangeProvider ?? "")
    .toLowerCase()
    .trim();
  if (!exchangeId || !exchangeProvider) return { v2Exchange };
  const brokerExchange24h =
    await requestOptional<BrokerExchangeDailySnapshots24hResponse>(
      client,
      BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H,
      {
        chainId,
        exchangeProvider,
        exchangeId,
        since: currentUtcDayStartSeconds(),
      },
      signal,
    );
  return { v2Exchange, brokerExchange24h };
}

// Prefetch the per-feed breaker config so `<BreakerPanel />` and
// `<MarketHoursPill />` know on first paint whether the pool has a trip-able
// breaker / is FX-gated — eliminating the skeleton→null collapse (BreakerPanel)
// and the phantom-pill flash (MarketHoursPill) on the less-common no-breaker /
// non-FX pools. Mirrors the client query gate exactly: both components skip the
// query for virtual pools and for pools without a `referenceRateFeedID`, so the
// server must skip it in the same cases or the fallbackData shape would diverge
// from the client's SWR key (which would be `null`, i.e. no request at all).
async function fetchPoolBreakerConfig(
  client: PoolDetailClient,
  chainId: number,
  pool: Pool,
  signal: AbortSignal,
): Promise<PoolBreakerConfigResponse | undefined> {
  const rateFeedID = pool.referenceRateFeedID ?? "";
  if (isVirtualPool(pool) || !rateFeedID) return undefined;
  return requestOptional<PoolBreakerConfigResponse>(
    client,
    POOL_BREAKER_CONFIG,
    { chainId, rateFeedID },
    signal,
  );
}

async function fetchPoolDetailUncached(
  chainId: number,
  id: string,
): Promise<PoolDetailInitialData | undefined> {
  // Resolve the network the same way NetworkProvider does on the client
  // (configured-only), so we hit the same endpoint the client will key against.
  const networkId = configuredNetworkIdForChainId(chainId);
  if (networkId === null) return undefined;
  const network = NETWORKS[networkId];
  if (!network.hasuraUrl) return undefined;

  const client = makeOgGraphQLClient(network);
  const signal = AbortSignal.timeout(HASURA_TIMEOUT_MS);
  const rawPool = await requestOptional<PoolDetailResponse>(
    client,
    POOL_DETAIL_WITH_HEALTH,
    { id, chainId },
    signal,
  );
  const oracleFreshnessCheckedAt = Date.now() / 1000;
  const pool = rawPool
    ? {
        ...rawPool,
        Pool: rawPool.Pool.map((row) => ({
          ...row,
          oracleFreshnessCheckedAt,
        })),
      }
    : undefined;
  const poolRow = pool?.Pool?.[0];
  if (!poolRow) {
    // Degrade to no fallback: the client hooks fetch normally and their own
    // reserved-height loading paths take over. Never block the render on this.
    return undefined;
  }

  const [
    thresholds,
    vpOracleFreshness,
    vpDeprecation,
    vpLifecycleDeprecation,
    headerInitialData,
    breakerConfig,
  ] = await Promise.all([
    requestOptional<PoolThresholdsKnownExtResponse>(
      client,
      POOL_THRESHOLDS_KNOWN_EXT,
      { id, chainId },
      signal,
    ),
    requestOptional<PoolVpOracleFreshnessExtResponse>(
      client,
      POOL_VP_ORACLE_FRESHNESS_EXT,
      { id, chainId },
      signal,
    ).then((response) => {
      if (!response) return undefined;
      const vpOracleFreshnessCheckedAt = Date.now() / 1000;
      return {
        ...response,
        Pool: response.Pool.map((row) => ({
          ...row,
          vpOracleFreshnessCheckedAt,
        })),
      };
    }),
    requestOptional<PoolVpDeprecationExtResponse>(
      client,
      POOL_VP_DEPRECATION_EXT,
      { id, chainId },
      signal,
    ),
    requestOptional<PoolVpLifecycleDeprecationExtResponse>(
      client,
      POOL_VP_LIFECYCLE_DEPRECATION_EXT,
      { id, chainId },
      signal,
    ),
    fetchVirtualPoolHeaderInitialData(client, chainId, poolRow, signal),
    fetchPoolBreakerConfig(client, chainId, poolRow, signal),
  ]);
  const { v2Exchange, brokerExchange24h } = headerInitialData;

  return {
    pool,
    thresholds,
    vpOracleFreshness,
    vpDeprecation,
    vpLifecycleDeprecation,
    v2Exchange,
    brokerExchange24h,
    breakerConfig,
    // Stamp fetch-completion time so the consumer can age-gate the cached
    // breaker fallback (below). Rides in the cached payload (plain number).
    fetchedAt: Date.now(),
  };
}

// 60s revalidate matches the OG cache and the client polling cadence: the fallback
// paints instantly, then the client's useGQL revalidates on mount for fresh data.
// The raw response is plain JSON (no Map/Set), so unstable_cache serialization is
// lossless here.
const fetchPoolDetailCached = unstable_cache(
  fetchPoolDetailUncached,
  ["pool-detail-ssr"],
  { revalidate: 60, tags: ["pool-detail-ssr"] },
);

// Max age for the breaker config to still ride as first-paint SWR fallback.
// `unstable_cache`'s `revalidate: 60` is stale-WHILE-revalidate, not a max
// age: an idle or failed-refresh entry can serve arbitrarily-old data, and the
// breaker config is operator-safety state (tripped / market-hours). Reuse the
// repo's established served-staleness bound — `MAX_SERVED_STALENESS_MS` (5 min,
// aligned with the SNAPSHOT_REFRESH_MS client poll) from the SSR network cache
// — rather than inventing a new number: a healthy entry is ≤60s old so this
// only trips on genuinely stale entries, and on a trip the client just loads
// the feed fresh (skeleton), the same clean-load path as the feed-match guard.
const MAX_BREAKER_FALLBACK_AGE_MS = 300_000;

/**
 * Age-gate the cached breaker fallback: this runs per request (NOT inside the
 * `unstable_cache` boundary — mirrors `fetchInitialNetworkData`), so it compares
 * the request time against the cached payload's `fetchedAt`. Over-age → strip
 * `breakerConfig` (undefined) so BreakerPanel / MarketHoursPill load the feed
 * fresh instead of painting stale operator-safety state as the "last confirmed
 * state" (issue #1257). Composes with the client-side feed-match guard in
 * pool-detail-page-client.tsx — both gate whether the SSR fallback is
 * trustworthy. Server-side (not client-side) so the decision is fixed for both
 * the server render and hydration render — a client-side `Date.now()` gate
 * would risk a hydration mismatch. Only the breaker fallback is gated; the pool
 * row + thresholds stay so the header/health CLS fix is unaffected.
 */
export async function fetchPoolDetailForSSR(
  chainId: number,
  id: string,
  nowMs = Date.now(),
): Promise<PoolDetailInitialData | undefined> {
  const data = await fetchPoolDetailCached(chainId, id);
  if (!data?.breakerConfig || data.fetchedAt === undefined) return data;
  if (nowMs - data.fetchedAt <= MAX_BREAKER_FALLBACK_AGE_MS) return data;
  return { ...data, breakerConfig: undefined };
}
