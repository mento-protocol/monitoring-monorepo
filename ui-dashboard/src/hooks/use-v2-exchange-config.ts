"use client";

import useSWR from "swr";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import type { Pool } from "@/lib/types";
import { isVirtualPool } from "@/lib/types";

// Mirrors the route's serialized response — bigints come over the wire as
// decimal strings. Components convert to BigInt where they need arithmetic.
export type V2ExchangeConfigDTO = {
  exchangeId: string;
  exchangeProvider: string;
  asset0: string;
  asset1: string;
  pricingModule: string;
  pricingModuleName: string;
  spread: string;
  referenceRateFeedID: string;
  referenceRateResetFrequency: string;
  minimumReports: string;
  stablePoolResetSize: string;
  bucket0: string;
  bucket1: string;
  lastBucketUpdate: string;
  isDeprecated: boolean;
};

export type V2ExchangeConfigResponse =
  | { ok: true; config: V2ExchangeConfigDTO }
  | {
      ok: false;
      reason: "no_bytecode" | "not_a_virtual_pool" | "rpc_failed";
    };

/**
 * Resolve the v2 BiPoolManager exchange that backs a VirtualPool. Server-side
 * route extracts exchangeId from the VP's bytecode + reads live state from
 * BiPoolManager. Returns null on non-virtual pools (the hook is a no-op so
 * callers can call it unconditionally without manual gating).
 *
 * The route caches 30s — bucket reset cadence is 6 min, so 30s is fresh
 * enough to track resets while keeping requests cheap.
 */
export function useV2ExchangeConfig(pool: Pool | null): {
  data: V2ExchangeConfigResponse | null;
  isLoading: boolean;
  error: Error | undefined;
} {
  const shouldFetch = pool != null && isVirtualPool(pool);
  const address = pool ? stripChainIdFromPoolId(pool.id) : null;
  const key = shouldFetch
    ? `/api/v2-exchange-config/${pool.chainId}/${address}`
    : null;

  const { data, error, isLoading } = useSWR<V2ExchangeConfigResponse>(
    key,
    fetchV2ExchangeConfig,
    {
      // Bucket cadence on Celo is 360s. 60s revalidation keeps the
      // "lastBucketUpdate" stale-pill within ~1 reset cycle without
      // hammering the upstream RPC route.
      refreshInterval: 60_000,
      revalidateOnFocus: false,
      dedupingInterval: 15_000,
      shouldRetryOnError: false,
    },
  );

  return {
    data: data ?? null,
    isLoading: shouldFetch && isLoading,
    error,
  };
}

async function fetchV2ExchangeConfig(
  url: string,
): Promise<V2ExchangeConfigResponse> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `V2 exchange config failed (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as V2ExchangeConfigResponse;
}
