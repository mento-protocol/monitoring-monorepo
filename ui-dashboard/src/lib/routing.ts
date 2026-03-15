/**
 * Routing helpers used across pages and tests.
 */

/**
 * Returns the /pools redirect destination when a pool is not found on the
 * current network. Preserves the active ?network= param so the user lands on
 * the correct chain rather than the default.
 */
export function buildPoolNotFoundDest(networkParam: string | null): string {
  return networkParam ? `/pools?network=${networkParam}` : "/pools";
}
