// Server-only by convention (like lib/pool-og.ts): imported exclusively from the
// `/pool/[poolId]` Server Component, and it pulls in no client-only modules
// (`useSWR`/`useNetwork`/`next-auth`). Deliberately NOT using `import "server-only"`
// — that guard throws under the (non-RSC) vitest environment that transitively
// imports this via page.tsx, exactly as pool-og.ts avoids it.
import { unstable_cache } from "next/cache";
import { makeOgGraphQLClient } from "@/lib/og-graphql-client";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";
import {
  POOL_DETAIL_WITH_HEALTH,
  type PoolDetailResponse,
} from "@/lib/queries/pool-detail";
import { NETWORKS, configuredNetworkIdForChainId } from "@/lib/networks";

// SSR-prefetch of the pool-overview query. `/pool/[poolId]` is otherwise a pure
// client waterfall: PoolOverview swaps a short skeleton for a tall header + health
// block once the client fetch resolves, which is the measured CLS 0.25. Fetching
// the same query + variables server-side and handing the result to the client as
// fallbackData lets the overview paint immediately, eliminating that shift.
//
// Distinct from lib/pool-og.ts: that fetch merges extensions and returns a
// transformed PoolOgData shape for OG images; this returns the raw response.
async function fetchPoolDetailUncached(
  chainId: number,
  id: string,
): Promise<PoolDetailResponse | undefined> {
  // Resolve the network the same way NetworkProvider does on the client
  // (configured-only), so we hit the same endpoint the client will key against.
  const networkId = configuredNetworkIdForChainId(chainId);
  if (networkId === null) return undefined;
  const network = NETWORKS[networkId];
  if (!network.hasuraUrl) return undefined;

  try {
    // Bound the request: this await runs during the server render, so a slow or
    // hung Hasura would otherwise stall the whole pool page's HTML response.
    return await makeOgGraphQLClient(network).request<PoolDetailResponse>({
      document: POOL_DETAIL_WITH_HEALTH,
      variables: { id, chainId },
      signal: AbortSignal.timeout(HASURA_TIMEOUT_MS),
    });
  } catch {
    // Degrade to no fallback: the client hook fetches normally and its own
    // reserved-height loading path takes over. Never block the render on this.
    return undefined;
  }
}

// 60s revalidate matches the OG cache and the client polling cadence: the fallback
// paints instantly, then the client's useGQL revalidates on mount for fresh data.
// The raw response is plain JSON (no Map/Set), so unstable_cache serialization is
// lossless here.
export const fetchPoolDetailForSSR = unstable_cache(
  fetchPoolDetailUncached,
  ["pool-detail-ssr"],
  { revalidate: 60, tags: ["pool-detail-ssr"] },
);
