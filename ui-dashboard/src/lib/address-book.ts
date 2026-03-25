/**
 * Pure helpers for address book row composition.
 * Shared between page.tsx and tests so both always exercise the same logic.
 *
 * IMPORTANT: custom labels are persisted and fetched by chainId (not network.id).
 * Two network configs can share the same chainId (e.g. "celo-mainnet-hosted" and
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
  label: string;
  isCustom: boolean;
  /** Network this contract label belongs to; null for custom-only rows */
  network: Network | null;
};

/**
 * Merges contract rows (from all networks) and custom rows (from the selected
 * chain only). Custom rows take precedence over contract rows for the same
 * (selectedChainId, address) pair; contract rows from other chains are always
 * kept.
 */
export function buildAddressBookRows(
  contractRows: AddressBookRow[],
  customRows: AddressBookRow[],
  selectedChainId: number,
): AddressBookRow[] {
  // Key by (chainId, normalised address) — matches custom label storage scope
  const customKeys = new Set(
    customRows.map((r) => `${selectedChainId}:${r.address.toLowerCase()}`),
  );
  const filteredContractRows = contractRows.filter(
    (r) =>
      !customKeys.has(`${r.network?.chainId ?? -1}:${r.address.toLowerCase()}`),
  );
  return [...customRows, ...filteredContractRows];
}

/**
 * Returns true when the row should be displayed as a custom label.
 * isCustomLabel() is scoped to the selected chain, so it is only consulted
 * for rows on that chain to avoid false positives on other chains.
 */
export function resolveIsCustom(
  row: AddressBookRow,
  selectedChainId: number,
  isCustomLabel: (address: string) => boolean,
): boolean {
  const isOnSelectedChain =
    row.network === null || row.network.chainId === selectedChainId;
  return row.isCustom || (isOnSelectedChain && isCustomLabel(row.address));
}

/**
 * Returns true when this row can be edited on the current chain.
 * False for contract rows from a different chain — editing would write to the
 * wrong Redis hash via the chain-scoped AddressLabelEditor.
 */
export function resolveCanEdit(
  row: AddressBookRow,
  selectedChainId: number,
): boolean {
  return row.network === null || row.network.chainId === selectedChainId;
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
    for (const e of parsed as Array<Record<string, unknown>>) {
      keys.add(importKey(String(e.chainId), String(e.address)));
    }
    return keys.size;
  }

  if (typeof parsed === "object" && parsed !== null && "chains" in parsed) {
    // Snapshot format: { chains: { chainId: { address: entry } } }
    const chains = (
      parsed as { chains: Record<string, Record<string, unknown>> }
    ).chains;
    for (const [chainId, entries] of Object.entries(chains)) {
      for (const address of Object.keys(entries)) {
        keys.add(importKey(chainId, address));
      }
    }
    return keys.size;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "labels" in parsed &&
    typeof (parsed as { labels: unknown }).labels === "object"
  ) {
    // Simple format: { chainId, labels: { address: entry } }
    const { chainId, labels } = parsed as {
      chainId: number;
      labels: Record<string, unknown>;
    };
    for (const address of Object.keys(labels)) {
      keys.add(importKey(chainId, address));
    }
    return keys.size;
  }

  return 0;
}
