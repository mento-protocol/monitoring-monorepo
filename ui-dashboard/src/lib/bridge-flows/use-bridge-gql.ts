"use client";

import { GraphQLClient } from "graphql-request";
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

let cachedClient: GraphQLClient | null = null;
function getClient(): GraphQLClient | null {
  if (!MULTICHAIN_HASURA_URL) return null;
  if (!cachedClient)
    cachedClient = new GraphQLClient(MULTICHAIN_HASURA_URL, { headers: {} });
  return cachedClient;
}

export function useBridgeGQL<T>(
  query: string | null,
  variables?: Record<string, unknown>,
  refreshInterval = 10_000,
): SWRResponse<T> {
  const client = getClient();

  const result = useSWR<T>(
    query && client ? ["bridge-multichain", query, variables] : null,
    () => client!.request<T>(query!, variables),
    { refreshInterval },
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
