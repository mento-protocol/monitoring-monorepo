/**
 * Wormholescan is the canonical cross-chain trace UI for a Wormhole transfer,
 * keyed by digest. Resolves even when the source tx hasn't been indexed by
 * Wormholescan yet — useful for PENDING transfers.
 */
export function wormholescanUrl(digest: string): string {
  return `https://wormholescan.io/#/tx/${digest}`;
}
