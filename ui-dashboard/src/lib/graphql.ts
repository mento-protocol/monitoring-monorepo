import { GraphQLClient } from "graphql-request";
import { useMemo } from "react";
import useSWR, { type SWRResponse } from "swr";
import { useNetwork } from "@/components/network-provider";
import { pausableRefreshInterval, rateLimitAwareRetry } from "@/lib/gql-retry";
import type { Network } from "@/lib/networks";

// Cache clients per Hasura URL so we don't recreate on every render
const clientCache = new Map<string, GraphQLClient>();

function getClient(network: Network): GraphQLClient {
  const cached = clientCache.get(network.hasuraUrl);
  if (cached) return cached;
  const client = new GraphQLClient(network.hasuraUrl);
  clientCache.set(network.hasuraUrl, client);
  return client;
}

// Pool-level data (oracle, reserves, health) doesn't move fast enough to
// justify a shorter interval, and a single pool page fans out ~15–20 parallel
// useGQL calls — at 10s we were burning the Envio "small" tier monthly quota
// and hitting 429 "Tier Quota" errors mid-session.
const DEFAULT_REFRESH_MS = 30_000;

/**
 * Network-aware GraphQL hook.
 * Automatically switches Hasura endpoint based on the current network context.
 * SWR cache keys include the network ID so data doesn't bleed across networks.
 *
 * When the network's Hasura URL is empty (unconfigured network),
 * the fetch is skipped and a descriptive error is returned immediately.
 */
export function useGQL<T>(
  query: string | null,
  variables?: Record<string, unknown>,
  refreshInterval: number = DEFAULT_REFRESH_MS,
): SWRResponse<T> {
  const { network } = useNetwork();
  const client = getClient(network);

  // Stabilize the refresh-interval resolver across renders so SWR doesn't
  // tear down and re-arm its polling timer on every state update.
  const resolveRefreshInterval = useMemo(
    () => pausableRefreshInterval(refreshInterval),
    [refreshInterval],
  );

  const result = useSWR<T>(
    query && network.hasuraUrl ? [network.id, query, variables] : null,
    () => client.request<T>(query!, variables),
    {
      refreshInterval: resolveRefreshInterval,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );

  if (!network.hasuraUrl) {
    return {
      ...result,
      isLoading: false,
      error: new Error(
        `Hasura URL not configured for "${network.label}". ` +
          `Get the GraphQL endpoint from the Envio dashboard and set it in .env.local.`,
      ),
    } as SWRResponse<T>;
  }

  return result;
}
