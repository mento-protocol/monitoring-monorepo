"use client";

import { GraphQLClient } from "graphql-request";
import useSWR from "swr";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import {
  fetchBrokerViaMarkerPages,
  type BrokerViaMarkerPageResult,
} from "@/lib/leaderboard-via";
import type { Network } from "@/lib/networks";

const clientCache = new Map<string, GraphQLClient>();
const REFRESH_MS = 30_000;

function getClient(network: Network): GraphQLClient {
  const cached = clientCache.get(network.hasuraUrl);
  if (cached) return cached;
  const client = new GraphQLClient(network.hasuraUrl);
  clientCache.set(network.hasuraUrl, client);
  return client;
}

export function useBrokerViaMarkers(idRegex: string | null) {
  const { network } = useNetwork();
  return useSWR<BrokerViaMarkerPageResult>(
    idRegex && network.hasuraUrl ? [network.id, "broker-via", idRegex] : null,
    () => fetchBrokerViaMarkerPages(getClient(network), idRegex!),
    {
      refreshInterval: REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );
}
