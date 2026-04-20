/**
 * Load and index the generator-produced NTT address manifest.
 *
 * The JSON at config/nttAddresses.json is commit-tracked. Regenerate via
 * `pnpm generate:ntt-addresses` after bumping @mento-protocol/contracts.
 */
import nttAddresses from "../../config/nttAddresses.json";

export type NttAddressEntry = {
  chainId: number;
  wormholeChainId: number;
  tokenSymbol: string;
  tokenAddress: string; // lowercased
  tokenDecimals: number;
  helper: string;
  nttManagerProxy: string;
  transceiverProxy: string;
};

const ENTRIES = (nttAddresses as { entries: NttAddressEntry[] }).entries;

function indexBy(
  key: (e: NttAddressEntry) => string,
): Map<string, NttAddressEntry> {
  const m = new Map<string, NttAddressEntry>();
  for (const e of ENTRIES) m.set(key(e), e);
  return m;
}

const BY_MANAGER = indexBy(
  (e) => `${e.chainId}:${e.nttManagerProxy.toLowerCase()}`,
);

export function findByNttManager(
  chainId: number,
  manager: string,
): NttAddressEntry | null {
  return BY_MANAGER.get(`${chainId}:${manager.toLowerCase()}`) ?? null;
}
