"use client";

import { GraphQLClient, type Variables } from "graphql-request";
import useSWR, { type SWRResponse } from "swr";

/**
 * Bridge-flows data lives in the multichain indexer, not in any per-network
 * Hasura endpoint. The generic `useGQL` hook routes through `useNetwork()`'s
 * `hasuraUrl` — fine for pool/swap data that's chain-specific, but wrong for
 * bridge data which is bi-chain and served from a single endpoint. Using the
 * generic hook here causes the bridge page to render empty/error when the
 * user's selected network (e.g. a testnet) has an unset `hasuraUrl` — even
 * though `NEXT_PUBLIC_HASURA_URL_MULTICHAIN` is set and the data exists.
 *
 * This hook reads `NEXT_PUBLIC_HASURA_URL_MULTICHAIN` directly so bridge
 * queries stay correct regardless of selected network context.
 */

const MULTICHAIN_HASURA_URL = (
  process.env.NEXT_PUBLIC_HASURA_URL_MULTICHAIN ?? ""
).trim();

// Cap each GraphQL request well below the 10s SWR refresh interval so a
// wedged TCP connection can't compound into unbounded backpressure on the
// polling fetcher. AbortSignal.timeout is propagated by graphql-request to
// the underlying fetch.
const REQUEST_TIMEOUT_MS = 8_000;

let cachedClient: GraphQLClient | null = null;
function getClient(): GraphQLClient | null {
  if (!MULTICHAIN_HASURA_URL) return null;
  if (!cachedClient) cachedClient = new GraphQLClient(MULTICHAIN_HASURA_URL);
  return cachedClient;
}

export function useBridgeGQL<T>(
  query: string | null,
  variables?: Variables,
  refreshInterval = 10_000,
): SWRResponse<T> {
  const client = getClient();

  const result = useSWR<T>(
    query && client ? ["bridge-multichain", query, variables] : null,
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
        "NEXT_PUBLIC_HASURA_URL_MULTICHAIN is not configured. Set it in .env.local " +
          "(or Vercel env vars) to the bridge indexer's Hasura endpoint.",
      ),
    } as SWRResponse<T>;
  }

  return result;
}
