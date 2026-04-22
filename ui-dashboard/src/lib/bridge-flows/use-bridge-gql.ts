"use client";

import { GraphQLClient, type Variables } from "graphql-request";
import useSWR, { type SWRResponse } from "swr";

/**
 * Bridge queries run outside the per-network SWR context: cache key is network-
 * agnostic, and the hook drops `revalidateOnFocus` + `revalidateOnReconnect` to
 * avoid fanning requests across tabs into Envio's rate limit (see below).
 */

const BRIDGE_HASURA_URL = (process.env.NEXT_PUBLIC_HASURA_URL ?? "").trim();

// Cap each GraphQL request well below the 10s SWR refresh interval so a
// wedged TCP connection can't compound into unbounded backpressure on the
// polling fetcher. AbortSignal.timeout is propagated by graphql-request to
// the underlying fetch.
const REQUEST_TIMEOUT_MS = 8_000;

let cachedClient: GraphQLClient | null = null;
function getClient(): GraphQLClient | null {
  if (!BRIDGE_HASURA_URL) return null;
  if (!cachedClient) cachedClient = new GraphQLClient(BRIDGE_HASURA_URL);
  return cachedClient;
}

export function useBridgeGQL<T>(
  query: string | null,
  variables?: Variables,
  refreshInterval = 10_000,
): SWRResponse<T> {
  const client = getClient();

  const result = useSWR<T>(
    query && client ? ["bridge", query, variables] : null,
    () =>
      client!.request<T>({
        document: query!,
        variables,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    {
      refreshInterval,
      // The 10s polling loop already keeps bridge data fresh; piling
      // focus + reconnect revalidations on top was fanning each tab-
      // resume across every active bridge query and tripping Envio's
      // GraphQL 429 rate limit. Scoped to this hook (the global SWR
      // config leaves them on for one-shot reads elsewhere).
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );

  if (!client) {
    return {
      ...result,
      isLoading: false,
      error: new Error(
        "NEXT_PUBLIC_HASURA_URL is not configured. Set it in .env.local " +
          "(or Vercel env vars) to the indexer's Hasura endpoint.",
      ),
    } as SWRResponse<T>;
  }

  return result;
}
