// Server-only by convention (like lib/pool-detail-ssr.ts): imported exclusively
// from the `/volume` Server Component, and it pulls in no client-only modules
// (`useSWR`/`useNetwork`/`next-auth`). Deliberately NOT using `import
// "server-only"` — that guard throws under the (non-RSC) vitest environment
// that transitively imports this via page.tsx, exactly as pool-detail-ssr.ts
// avoids it.
import { unstable_cache } from "next/cache";
import { makeOgGraphQLClient } from "@/lib/og-graphql-client";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import { DEFAULT_NETWORK, NETWORKS } from "@/lib/networks";
import {
  BROKER_VOLUME_TODAY_TRADERS,
  BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST,
  BROKER_VOLUME_WINDOW_LATEST,
  VOLUME_TODAY_TRADERS,
  VOLUME_WINDOW_FIRSTDAY_LATEST,
  VOLUME_WINDOW_LATEST,
} from "@/lib/queries/volume";
import type { VolumeRangeKey } from "@/lib/volume";
import {
  protocolActorInForView,
  type BrokerVolumeTodayTradersResponse,
  type BrokerVolumeWindowFirstDayLatestResponse,
  type BrokerVolumeWindowLatestResponse,
  type VolumeHeroInitialData,
  type VolumeTodayTradersResponse,
  type VolumeWindowFirstDayLatestResponse,
  type VolumeWindowLatestResponse,
} from "@/lib/volume-hero-initial-data";
import type { Venue } from "@/lib/volume-url-params";

// SSR-prefetch of the /volume hero queries (perf-plan S4, mirroring the proven
// pool-detail pattern). `/volume` is otherwise a pure client waterfall: the
// hero headline, KPI tiles, and data-quality banners all wait for
// HTML → JS → hydrate → client GraphQL. Fetching the same query variables
// server-side and handing the raw responses to `useHeroRollup` as per-query
// fallbackData lets the first render paint populated numbers.
//
// Only the UNCONDITIONAL first-render queries are prefetched (window snapshot,
// today partial, firstDay slice). The conditional second-wave queries
// (yesterday catch-up / partial-overlap) are gated on the merge result and
// stay client-only.

type VolumeSsrClient = ReturnType<typeof makeOgGraphQLClient>;

async function requestOptional<T>(
  client: VolumeSsrClient,
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

async function fetchVolumeHeroUncached(
  venue: Venue,
  range: VolumeRangeKey,
  includeProtocolActors: boolean,
  // Passed in (not computed here) so it is part of the unstable_cache key —
  // the cache can never serve a stale UTC day past midnight — and so the view
  // descriptor records exactly what was fetched.
  todayMidnight: number,
): Promise<VolumeHeroInitialData | undefined> {
  // `/volume` isn't a pool route, so NetworkProvider always resolves
  // DEFAULT_NETWORK on the client — prefetch against the same endpoint the
  // client's SWR keys will use.
  const network = NETWORKS[DEFAULT_NETWORK];
  if (!network.hasuraUrl) return undefined;

  const client = makeOgGraphQLClient(network);
  const signal = AbortSignal.timeout(HASURA_TIMEOUT_MS);
  const isProtocolActorIn = protocolActorInForView(includeProtocolActors);
  const windowVariables = { windowKey: range };
  const todayVariables = { todayMidnight, isProtocolActorIn };

  const view = {
    networkId: network.id,
    venue,
    range,
    includeProtocolActors,
    todayMidnight,
  };

  if (venue === "v2") {
    const [heroV2, todayV2, firstDayV2] = await Promise.all([
      requestOptional<BrokerVolumeWindowLatestResponse>(
        client,
        BROKER_VOLUME_WINDOW_LATEST,
        windowVariables,
        signal,
      ),
      requestOptional<BrokerVolumeTodayTradersResponse>(
        client,
        BROKER_VOLUME_TODAY_TRADERS,
        todayVariables,
        signal,
      ),
      requestOptional<BrokerVolumeWindowFirstDayLatestResponse>(
        client,
        BROKER_VOLUME_WINDOW_FIRSTDAY_LATEST,
        windowVariables,
        signal,
      ),
    ]);
    // The hero tiles gate their loading state on the PRIMARY pair (window +
    // today). If either failed, degrade to no fallback at all: the client
    // hooks fetch normally and today's loading path takes over. Never hand
    // back a partial pair that could paint happy-path zeros. The firstDay
    // catch-up slice stays optional (schema-lag resilient).
    return heroV2 && todayV2
      ? { view, heroV2, todayV2, firstDayV2 }
      : undefined;
  }

  const [heroV3, todayV3, firstDayV3] = await Promise.all([
    requestOptional<VolumeWindowLatestResponse>(
      client,
      VOLUME_WINDOW_LATEST,
      windowVariables,
      signal,
    ),
    requestOptional<VolumeTodayTradersResponse>(
      client,
      VOLUME_TODAY_TRADERS,
      todayVariables,
      signal,
    ),
    requestOptional<VolumeWindowFirstDayLatestResponse>(
      client,
      VOLUME_WINDOW_FIRSTDAY_LATEST,
      windowVariables,
      signal,
    ),
  ]);
  // Same primary-pair rule as the v2 branch above.
  return heroV3 && todayV3 ? { view, heroV3, todayV3, firstDayV3 } : undefined;
}

// 60s revalidate matches pool-detail-ssr and the client polling cadence: the
// fallback paints instantly, then the client's useGQL revalidates on mount.
// The raw responses are plain JSON (no Map/Set/BigInt — Hasura numerics are
// strings), so unstable_cache serialization is lossless here.
//
// The key is salted with the deployment SHA ("dev" locally) because Vercel's
// Data Cache persists across deployments within an environment — without the
// salt, a deploy that changes the response shape or view-descriptor contract
// could serve an entry written by older code for up to the TTL (same hazard
// the homepage cache in network-fetcher/server-cache.ts guards against; view
// variables such as venue, range, and todayMidnight are already part of the
// key via the wrapped function's arguments).
export const fetchVolumeHeroForSSR = unstable_cache(
  fetchVolumeHeroUncached,
  ["volume-hero-ssr", process.env.VERCEL_GIT_COMMIT_SHA ?? "dev"],
  { revalidate: 60, tags: ["volume-hero-ssr"] },
);
