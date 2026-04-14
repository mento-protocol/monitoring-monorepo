/**
 * Routing helpers used across pages and tests.
 */

import {
  DEFAULT_NETWORK,
  isCanonicalNetwork,
  type IndexerNetworkId,
} from "@/lib/networks";

/**
 * Redirect destination when a pool isn't found on the active network.
 * Must be the caller's *active* network id (from `useNetwork()`) — if the
 * user just changed the selector, they land on the new chain's pools list.
 */
export function buildPoolNotFoundDest(networkId: IndexerNetworkId): string {
  if (networkId === DEFAULT_NETWORK) return "/pools";
  const params = new URLSearchParams({ network: networkId });
  return `/pools?${params.toString()}`;
}

/**
 * Returns the /pools navigation URL for a given pool filter and limit,
 * building on top of the current search params. Used by the pools page
 * filter/limit controls so all URL state stays under /pools.
 *
 * @param currentParams - The existing URLSearchParams (from useSearchParams())
 * @param pool          - Pool address filter; empty string to clear
 * @param limit         - Rows per page; 25 is the default (omitted from URL)
 */
export function buildPoolsFilterUrl(
  currentParams: URLSearchParams,
  pool: string,
  limit: number,
): string {
  const p = new URLSearchParams(currentParams.toString());
  if (pool) p.set("pool", pool);
  else p.delete("pool");
  if (limit !== 25) p.set("limit", String(limit));
  else p.delete("limit");
  const qs = p.toString();
  return qs ? `/pools?${qs}` : "/pools";
}

// In-page URL updates (tab/limit/search, raw→namespaced canonicalization).
// Preserves all params — the network param may be the only anchor for a
// non-canonical network that shares a chainId with a canonical one.
export function buildPoolDetailUrl(
  poolId: string,
  currentParams: URLSearchParams,
): string {
  const qs = currentParams.toString();
  return `/pool/${encodeURIComponent(poolId)}${qs ? `?${qs}` : ""}`;
}

// New pool detail link from a listing. Canonical networks resolve from the
// pool id's chainId alone; non-canonical (local/devnet) must carry ?network=
// or navigation would silently swap the user onto the prod indexer.
export function buildPoolDetailHref(
  poolId: string,
  activeNetworkId: IndexerNetworkId,
): string {
  const base = `/pool/${encodeURIComponent(poolId)}`;
  return isCanonicalNetwork(activeNetworkId)
    ? base
    : `${base}?network=${activeNetworkId}`;
}
