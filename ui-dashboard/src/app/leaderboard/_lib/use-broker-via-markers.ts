"use client";

import { useMemo } from "react";
import { GraphQLClient } from "graphql-request";
import useSWR from "swr";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import {
  fetchBrokerViaMarkerIds,
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

function markerIdsCacheKey(markerIds: readonly string[]): string {
  let hash = 2166136261;
  for (const id of markerIds) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${markerIds.length}:${markerIds[0] ?? ""}:${markerIds.at(-1) ?? ""}:${(
    hash >>> 0
  ).toString(36)}`;
}

export function useBrokerViaMarkers(markerIds: readonly string[] | null) {
  const { network } = useNetwork();
  const markerKey = useMemo(
    () =>
      markerIds && markerIds.length > 0 ? markerIdsCacheKey(markerIds) : null,
    [markerIds],
  );
  return useSWR<BrokerViaMarkerPageResult>(
    markerKey && network.hasuraUrl
      ? [network.id, network.hasuraUrl, "broker-via", markerKey]
      : null,
    () => fetchBrokerViaMarkerIds(getClient(network), markerIds!),
    {
      refreshInterval: REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );
}
