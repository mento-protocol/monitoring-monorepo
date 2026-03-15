/**
 * Routing helpers used across pages and tests.
 */

/**
 * Returns the /pools redirect destination when a pool is not found on the
 * current network. Preserves the active ?network= param so the user lands on
 * the correct chain rather than the default.
 */
export function buildPoolNotFoundDest(networkParam: string | null): string {
  if (!networkParam) return "/pools";
  const params = new URLSearchParams({ network: networkParam });
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
