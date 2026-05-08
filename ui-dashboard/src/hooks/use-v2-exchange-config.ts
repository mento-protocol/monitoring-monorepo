"use client";

import useSWR from "swr";
import { fetchJsonOrThrow } from "@/lib/fetch-json";
import { stripChainIdFromPoolId } from "@/lib/pool-id";
import type { Network } from "@/lib/networks";
import { isVirtualPool, type Pool } from "@/lib/types";
import type {
  V2ExchangeConfigDTO,
  V2ExchangeConfigResponse,
} from "@/lib/v2-exchange-config";

export type { V2ExchangeConfigDTO, V2ExchangeConfigResponse };

/**
 * Resolve the v2 BiPoolManager exchange that backs a VirtualPool. Server
 * route extracts exchangeId from the VP's bytecode + reads live state from
 * BiPoolManager. Returns null on non-virtual pools (the hook is a no-op so
 * callers can call it unconditionally without manual gating).
 *
 * `network` is required because multiple configured networks can share a
 * chainId (e.g. `celo-mainnet` and `celo-mainnet-local` both resolve 42220);
 * without it, devnet/local virtual pools would silently route to mainnet RPC.
 *
 * The route caches 30s — bucket reset cadence is 6 min, so 30s is fresh
 * enough to track resets while keeping requests cheap.
 */
export function useV2ExchangeConfig(
  pool: Pool | null,
  network: Network,
): {
  data: V2ExchangeConfigResponse | null;
  isLoading: boolean;
  error: Error | undefined;
} {
  const shouldFetch = pool != null && isVirtualPool(pool);
  const address = pool ? stripChainIdFromPoolId(pool.id) : null;
  const key = shouldFetch
    ? `/api/v2-exchange-config/${pool.chainId}/${address}?network=${encodeURIComponent(network.id)}`
    : null;

  const { data, error, isLoading } = useSWR<V2ExchangeConfigResponse>(
    key,
    (url) =>
      fetchJsonOrThrow<V2ExchangeConfigResponse>(url, "V2 exchange config"),
    {
      // Bucket cadence on Celo is 360s. 60s revalidation keeps the
      // "lastBucketUpdate" stale-pill within ~1 reset cycle without
      // hammering the upstream RPC route.
      refreshInterval: 60_000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 15_000,
      // Custom retry — SWR 2.x suppresses `refreshInterval` while the
      // hook is in error state, so without an explicit retry path a
      // single upstream 502 wedges the panel until the user reloads.
      // Retry indefinitely at the same 60s cadence as `refreshInterval`
      // (no exponential-backoff burst) but only when the document is
      // visible, so background tabs don't pile up upstream calls during
      // a long outage.
      onErrorRetry: (_err, _key, _config, revalidate, { retryCount }) => {
        if (typeof document !== "undefined" && document.hidden) return;
        setTimeout(() => revalidate({ retryCount }), 60_000);
      },
    },
  );

  return {
    data: data ?? null,
    isLoading: shouldFetch && isLoading,
    error,
  };
}
