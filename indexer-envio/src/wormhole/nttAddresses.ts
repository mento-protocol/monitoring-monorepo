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
const BY_TRANSCEIVER = indexBy(
  (e) => `${e.chainId}:${e.transceiverProxy.toLowerCase()}`,
);

export function findByNttManager(
  chainId: number,
  manager: string,
): NttAddressEntry | null {
  return BY_MANAGER.get(`${chainId}:${manager.toLowerCase()}`) ?? null;
}

export function findByTransceiver(
  chainId: number,
  transceiver: string,
): NttAddressEntry | null {
  return BY_TRANSCEIVER.get(`${chainId}:${transceiver.toLowerCase()}`) ?? null;
}

export function allEntries(): ReadonlyArray<NttAddressEntry> {
  return ENTRIES;
}
