"use client";

import { GraphQLClient, type Variables } from "graphql-request";
import { useMemo } from "react";
import useSWR, { type SWRResponse } from "swr";
import { pausableRefreshInterval, rateLimitAwareRetry } from "@/lib/gql-retry";

/**
 * Bridge queries run outside the per-network SWR context: cache key is network-
 * agnostic, and the hook drops `revalidateOnFocus` + `revalidateOnReconnect` to
 * avoid fanning requests across tabs into Envio's rate limit (see below).
 */

const BRIDGE_HASURA_URL = (process.env.NEXT_PUBLIC_HASURA_URL ?? "").trim();

// Cap each GraphQL request well below the SWR refresh interval so a wedged
// TCP connection can't compound into unbounded backpressure on the polling
// fetcher.
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
  refreshInterval = 30_000,
): SWRResponse<T> {
  const client = getClient();

  const resolveRefreshInterval = useMemo(
    () => pausableRefreshInterval(refreshInterval),
    [refreshInterval],
  );

  const result = useSWR<T>(
    query && client ? ["bridge", query, variables] : null,
    () =>
      client!.request<T>({
        document: query!,
        variables,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    {
      refreshInterval: resolveRefreshInterval,
      refreshWhenHidden: false,
      // Focus + reconnect revalidations were fanning each tab-resume across
      // every active bridge query and tripping Envio's GraphQL 429. Scoped to
      // this hook; the global SWR config leaves them on for one-shot reads.
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      onErrorRetry: rateLimitAwareRetry,
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
