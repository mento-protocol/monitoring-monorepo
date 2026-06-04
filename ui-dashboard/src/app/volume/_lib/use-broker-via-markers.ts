"use client";

import { useMemo } from "react";
import { GraphQLClient } from "graphql-request";
import useSWR from "swr";
import { useNetwork } from "@/components/network-provider";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import {
  fetchBrokerTraderRouterMarkers,
  type BrokerViaMarkerPageResult,
} from "@/lib/volume-via";
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

function callersCacheKey(callers: readonly string[]): string {
  // Order matters for stable SWR keys — callers come in sorted lowercase from
  // the call site, but defensively sort here so a reorder of the visible top-N
  // doesn't churn the cache.
  const sorted = [...callers].sort();
  let hash = 2166136261;
  for (const caller of sorted) {
    for (let index = 0; index < caller.length; index += 1) {
      hash ^= caller.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  // Array.prototype.at is ES2022 — Safari ≤15 / Chrome ≤91 throw on it. The
  // dashboard targets ES2017 with no polyfill, so the indexed access form is
  // the safe alternative for any code path that ships to the browser.
  const last = sorted.length > 0 ? sorted[sorted.length - 1] : "";
  return `${sorted.length}:${sorted[0] ?? ""}:${last}:${(hash >>> 0).toString(36)}`;
}

export function useBrokerViaMarkers(
  callers: readonly string[] | null,
  cutoff: number,
) {
  const { network } = useNetwork();
  const callerKey = useMemo(
    () =>
      callers && callers.length > 0 && cutoff > 0
        ? callersCacheKey(callers)
        : null,
    [callers, cutoff],
  );
  return useSWR<BrokerViaMarkerPageResult>(
    callerKey && network.hasuraUrl
      ? [network.id, network.hasuraUrl, "broker-via", callerKey, cutoff]
      : null,
    () => fetchBrokerTraderRouterMarkers(getClient(network), callers!, cutoff),
    {
      refreshInterval: REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    },
  );
}
