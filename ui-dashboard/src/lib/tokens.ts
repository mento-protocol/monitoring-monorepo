import type { Pool } from "./types";
import type { Network } from "./networks";
import { truncateAddress } from "./format";

// ---------------------------------------------------------------------------
// Network-aware helpers
// ---------------------------------------------------------------------------

const USDM_SYMBOLS = new Set(["USDm"]);

export function tokenSymbol(network: Network, address: string | null): string {
  if (!address) return "?";
  return network.tokenSymbols[address.toLowerCase()] ?? truncateAddress(address);
}

export function addressLabel(network: Network, address: string | null): string {
  if (!address) return "\u2014";
  return network.addressLabels[address.toLowerCase()] ?? truncateAddress(address);
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
