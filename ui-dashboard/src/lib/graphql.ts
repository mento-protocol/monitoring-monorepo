import { GraphQLClient } from "graphql-request";
import useSWR, { type SWRResponse } from "swr";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
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
  /** Escape hatch for callers that need to override the defaults (e.g.
   *  re-enable focus revalidation for a one-shot read). Focus/reconnect
   *  revalidation is OFF by default for this hook — pool pages fan out
   *  ~15–20 parallel useGQL calls and every alt-tab would otherwise fire
   *  that many requests at once on top of the 30s polling cycle. */
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
    {
      refreshInterval,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
      ...swrOptions,
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
