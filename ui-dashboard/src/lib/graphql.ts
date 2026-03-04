import { GraphQLClient } from "graphql-request";
import useSWR, { type SWRResponse } from "swr";
import { useNetwork } from "@/components/network-provider";
import type { Network } from "@/lib/networks";

// Cache clients per Hasura URL so we don't recreate on every render
const clientCache = new Map<string, GraphQLClient>();

function getClient(network: Network): GraphQLClient {
  const cached = clientCache.get(network.hasuraUrl);
  if (cached) return cached;
  const client = new GraphQLClient(network.hasuraUrl, {
    headers: { "x-hasura-admin-secret": network.hasuraSecret },
  });
  clientCache.set(network.hasuraUrl, client);
  return client;
}

/**
 * Network-aware GraphQL hook.
 * Automatically switches Hasura endpoint based on the current network context.
 * SWR cache keys include the network ID so data doesn't bleed across networks.
 */
export function useGQL<T>(
  query: string | null,
  variables?: Record<string, unknown>,
  refreshInterval = 10_000,
): SWRResponse<T> {
  const { network } = useNetwork();
  const client = getClient(network);

  return useSWR<T>(
    query ? [network.id, query, variables] : null,
    () => client.request<T>(query!, variables),
    { refreshInterval },
  );
}
