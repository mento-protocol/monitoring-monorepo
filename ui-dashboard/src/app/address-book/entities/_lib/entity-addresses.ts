import { isValidAddress } from "@/lib/format";

export type EntityAddress = {
  address: string;
  chain: string | null;
  canOpenInAddressBook: boolean;
};

type UnknownEntityAddress = {
  address?: unknown;
  chain?: unknown;
  chainName?: unknown;
};

function readAddress(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return null;
  const { address } = item as UnknownEntityAddress;
  return typeof address === "string" ? address : null;
}

function readChain(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as UnknownEntityAddress;
  const chain = record.chain ?? record.chainName;
  return typeof chain === "string" && chain.trim() ? chain.trim() : null;
}

/**
 * Arkham entity snapshots came from more than one ingest generation. Accept
 * the known string and object shapes, drop malformed entries, and de-duplicate
 * case-insensitively so the UI never turns legacy payload drift into broken
 * address links.
 */
export function parseEntityAddresses(value: unknown): EntityAddress[] {
  if (!Array.isArray(value)) return [];

  const addresses = new Map<string, EntityAddress>();
  const addressesWithKnownChains = new Set<string>();

  for (const item of value) {
    const address = readAddress(item);
    if (!address?.trim()) continue;

    const normalizedAddress = address.trim();
    const addressKey = normalizedAddress.toLowerCase();
    const chain = readChain(item);
    const chainKey = chain?.toLowerCase() ?? "";

    if (!chain) {
      if (addressesWithKnownChains.has(addressKey)) continue;
    } else {
      addressesWithKnownChains.add(addressKey);
      addresses.delete(`${addressKey}\0`);
    }

    const key = `${addressKey}\0${chainKey}`;
    if (addresses.has(key)) continue;
    addresses.set(key, {
      address: normalizedAddress,
      chain,
      canOpenInAddressBook: isValidAddress(normalizedAddress),
    });
  }

  return Array.from(addresses.values()).sort((a, b) => {
    const chainComparison = (a.chain ?? "").localeCompare(b.chain ?? "");
    return (
      chainComparison ||
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );
  });
}
