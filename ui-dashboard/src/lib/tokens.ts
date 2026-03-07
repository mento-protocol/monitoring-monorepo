import type { Pool } from "./types";
import type { Network } from "./networks";
import { truncateAddress } from "./format";

// ---------------------------------------------------------------------------
// Network-aware helpers
// ---------------------------------------------------------------------------

const USDM_SYMBOLS = new Set(["USDm"]);

export function tokenSymbol(network: Network, address: string | null): string {
  if (!address) return "?";
  return (
    network.tokenSymbols[address.toLowerCase()] ?? truncateAddress(address)
  );
}

export function addressLabel(network: Network, address: string | null): string {
  if (!address) return "\u2014";
  return (
    network.addressLabels[address.toLowerCase()] ?? truncateAddress(address)
  );
}

export function hasLabel(network: Network, address: string | null): boolean {
  if (!address) return false;
  return address.toLowerCase() in network.addressLabels;
}

export function explorerAddressUrl(network: Network, address: string): string {
  return `${network.explorerBaseUrl}/address/${address}`;
}

export function explorerTxUrl(network: Network, txHash: string): string {
  return `${network.explorerBaseUrl}/tx/${txHash}`;
}

/** Pool display name like "KESm/USDm" with USDm always last. */
export function poolName(
  network: Network,
  token0: string | null,
  token1: string | null,
): string {
  const sym0 = tokenSymbol(network, token0);
  const sym1 = tokenSymbol(network, token1);

  if (USDM_SYMBOLS.has(sym0) && !USDM_SYMBOLS.has(sym1)) {
    return `${sym1}/${sym0}`;
  }
  return `${sym0}/${sym1}`;
}

/** Returns true if the pool is an FPMM (as opposed to a VirtualPool). */
export function isFpmm(pool: Pick<Pool, "source">): boolean {
  return pool.source.toLowerCase().includes("fpmm");
}

/** Lookup from pool ID -> display name for a list of pools. */
export function buildPoolNameMap(
  network: Network,
  pools: Pool[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of pools) {
    map[p.id] = poolName(network, p.token0, p.token1);
  }
  return map;
}

/**
 * Returns the Chainlink data feed URL for a given token symbol on Celo mainnet,
 * or null if no mapping is known. Only applicable to FPMM pools (oracle health).
 * All feeds are vs USD (the SortedOracles denomination).
 */
export function chainlinkFeedUrl(tokenSymbol: string): string | null {
  // Normalise: strip "axl" prefix and lowercase for matching
  const sym = tokenSymbol.replace(/^axl/i, "").toLowerCase();
  const slug = CHAINLINK_CELO_SLUG[sym];
  if (!slug) return null;
  return `https://data.chain.link/feeds/celo/mainnet/${slug}`;
}

/** Chainlink Celo mainnet feed slugs (base-usd format). */
const CHAINLINK_CELO_SLUG: Record<string, string> = {
  usdc: "usdc-usd",
  usdt: "usdt-usd",
  gbp: "gbp-usd",
  gbpm: "gbp-usd",
};
