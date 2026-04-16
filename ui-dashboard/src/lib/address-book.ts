/**
 * Pure helpers for address book row composition.
 * Shared between page.tsx and tests so both always exercise the same logic.
 *
 * IMPORTANT: custom labels are persisted and fetched by chainId (not network.id).
 * Two network configs can share the same chainId (e.g. "celo-mainnet" and
 * "celo-mainnet-local" both have chainId 42220). All scoping here uses chainId.
 *
 * Address comparisons are always case-insensitive (toLowerCase) because
 * @mento-protocol/contracts uses checksummed mixed-case addresses while Redis
 * stores lowercase addresses.
 */

import type { Network } from "@/lib/networks";

export type AddressBookRow = {
  key: string;
  address: string;
  name: string;
  tags: string[];
  isCustom: boolean;
  /** Network this row belongs to — every row is now chain-scoped. */
  network: Network;
};

/**
 * Merge contract rows and custom rows into a single de-duped list keyed by
 * `(chainId, lowercaseAddress)`. Custom rows take precedence when both sides
 * have an entry for the same pair.
 */
export function buildAddressBookRows(
  contractRows: AddressBookRow[],
  customRows: AddressBookRow[],
): AddressBookRow[] {
  const customKeys = new Set(
    customRows.map((r) => `${r.network.chainId}:${r.address.toLowerCase()}`),
  );
  const filteredContractRows = contractRows.filter(
    (r) => !customKeys.has(`${r.network.chainId}:${r.address.toLowerCase()}`),
  );
  return [...customRows, ...filteredContractRows];
}

/**
 * Canonical key used by the import API when persisting a label.
 * - chainId is parsed as a decimal integer (so "1" and "001" collapse to 1)
 * - address is lowercased (so checksummed and lowercase forms merge)
 */
function importKey(chainId: string | number, address: string): string {
  return `${Number(chainId)}:${address.toLowerCase()}`;
}

/**
 * Count the number of distinct labels that will be persisted from a parsed
 * import payload. Normalises all three formats to the same canonical
 * (Number(chainId), address.toLowerCase()) key used by the import API so
 * that the success toast never over-reports.
 */
export function countImportLabels(parsed: unknown): number {
  const keys = new Set<string>();

  if (Array.isArray(parsed)) {
    // Gnosis Safe format: Array<{ address, chainId, name }>
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).chainId === "string" &&
        typeof (entry as Record<string, unknown>).address === "string"
      ) {
        keys.add(
          importKey(
            (entry as Record<string, string>).chainId,
            (entry as Record<string, string>).address,
          ),
        );
      }
    }
    return keys.size;
  }

  if (typeof parsed === "object" && parsed !== null && "chains" in parsed) {
    // Snapshot format: { chains: { chainId: { address: entry } } }
    const chains = (parsed as { chains: unknown }).chains;
    if (
      typeof chains === "object" &&
      chains !== null &&
      !Array.isArray(chains)
    ) {
      for (const [chainId, entries] of Object.entries(
        chains as Record<string, unknown>,
      )) {
        if (
          typeof entries === "object" &&
          entries !== null &&
          !Array.isArray(entries)
        ) {
          for (const address of Object.keys(entries)) {
            keys.add(importKey(chainId, address));
          }
        }
      }
    }
    return keys.size;
  }

  if (typeof parsed === "object" && parsed !== null && "labels" in parsed) {
    // Simple format: { chainId, labels: { address: entry } }
    const { chainId, labels } = parsed as { chainId: unknown; labels: unknown };
    if (
      typeof labels === "object" &&
      labels !== null &&
      !Array.isArray(labels)
    ) {
      for (const address of Object.keys(labels)) {
        keys.add(importKey(chainId as number, address));
      }
    }
    return keys.size;
  }

  return 0;
}
