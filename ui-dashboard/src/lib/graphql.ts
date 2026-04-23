import { GraphQLClient } from "graphql-request";
import useSWR, { type SWRResponse } from "swr";
import { useNetwork } from "@/components/network-provider";
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
  refreshInterval = 10_000,
  /** Escape hatches for rate-limited endpoints. When a panel fires
   *  multiple polling queries in parallel (breach history: count +
   *  page + chart all against the same entity), leaving the global
   *  focus/reconnect revalidation on means every alt-tab multiplies
   *  burst load against Envio's Hasura. Callers in that shape should
   *  pass `{ revalidateOnFocus: false, revalidateOnReconnect: false }`
   *  — same pattern use-bridge-gql uses. Undefined here preserves the
   *  SWR global (focus/reconnect ON). */
  swrOptions?: {
    revalidateOnFocus?: boolean;
    revalidateOnReconnect?: boolean;
  },
): SWRResponse<T> {
  const { network } = useNetwork();
  const client = getClient(network);

  const result = useSWR<T>(
    query && network.hasuraUrl ? [network.id, query, variables] : null,
    () => client.request<T>(query!, variables),
    { refreshInterval, ...swrOptions },
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
