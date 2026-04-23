"use client";

import useSWR from "swr";
import { fetchAllNetworks, type NetworkData } from "@/lib/fetch-all-networks";
import { SHARED_QUERY_SWR_CONFIG } from "@/lib/gql-retry";
import { SWR_KEY_ALL_NETWORKS_DATA } from "@/lib/swr-keys";

type AllNetworksResult = {
  networkData: NetworkData[];
  isLoading: boolean;
  error: Error | null;
};

// Re-exports so long-established import sites keep working
// (`import { NetworkData, fetchAllNetworks, warnedCapKeys, ... } from
// "@/hooks/use-all-networks-data"`). New code should import directly from
// `@/lib/fetch-all-networks`.
export type { NetworkData, SnapshotPageResult } from "@/lib/fetch-all-networks";
export {
  fetchAllNetworks,
  fetchNetworkData,
  warnedCapKeys,
  partialPageLastCapturedAt,
} from "@/lib/fetch-all-networks";

/**
 * Fetches pools, full-history daily snapshots (paginated), protocol fees, and
 * LP counts for ALL configured networks in parallel.
 *
 * Optional `fallbackData` lets a Server Component pre-render the payload and
 * hand it off to this hook. When the SSR payload is all-healthy (no chain has
 * a top-level `error`), mount- and stale-revalidations are skipped so first
 * paint fires 0 client GraphQL requests. When any chain errored on the
 * server, revalidation is re-enabled so the client can recover immediately
 * instead of being stuck on the degraded state until the next poll —
 * important when a local/dev config has relative Hasura URLs that fail
 * server-side but work client-side. Options are applied at this hook's call
 * site rather than on an ancestor `SWRConfig` so they don't cascade to any
 * other `useSWR` in the tree.
 */
export function useAllNetworksData(
  fallbackData?: NetworkData[],
): AllNetworksResult {
  const allHealthy =
    fallbackData !== undefined && fallbackData.every((n) => n.error === null);
  const { data, error, isLoading } = useSWR<NetworkData[]>(
    SWR_KEY_ALL_NETWORKS_DATA,
    fetchAllNetworks,
    {
      ...SHARED_QUERY_SWR_CONFIG,
      ...(fallbackData !== undefined && { fallbackData }),
      ...(allHealthy && {
        revalidateOnMount: false,
        revalidateIfStale: false,
      }),
    },
  );

  return {
    networkData: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
