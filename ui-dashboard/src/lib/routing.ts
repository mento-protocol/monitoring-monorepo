/**
 * Routing helpers used across pages and tests.
 */

/** Redirect destination when a pool isn't found. */
export const POOL_NOT_FOUND_DEST = "/pools";

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

/**
 * Pool-detail URL updates for tab/limit/search state. The caller owns any
 * pool-id normalization; detail routes expect namespaced ids unless a caller
 * is still carrying explicit chain context during a raw-address redirect.
 */
export function buildPoolDetailUrl(
  poolId: string,
  currentParams: URLSearchParams,
): string {
  const qs = currentParams.toString();
  return `/pool/${encodeURIComponent(poolId)}${qs ? `?${qs}` : ""}`;
}

/**
 * Pool detail link from a listing. Pool IDs are namespaced `{chainId}-{addr}`
 * so the chain is recoverable from the path.
 */
export function buildPoolDetailHref(poolId: string): string {
  return `/pool/${encodeURIComponent(poolId)}`;
}
