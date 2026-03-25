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
 * Count the number of distinct labels that will be persisted from a parsed
 * import payload. Deduplicates Gnosis Safe entries by (chainId, address)
 * to match what the import API actually persists (lowercase address per chain).
 */
export function countImportLabels(parsed: unknown): number {
  if (Array.isArray(parsed)) {
    // Gnosis Safe format: Array<{ address, chainId, name }>
    const entries = parsed as Array<Record<string, unknown>>;
    return new Set(
      entries.map(
        (e) => `${String(e.chainId)}:${String(e.address).toLowerCase()}`,
      ),
    ).size;
  }
  if (typeof parsed === "object" && parsed !== null && "chains" in parsed) {
    // Snapshot format: { chains: { chainId: { address: entry } } }
    return Object.values(
      (parsed as { chains: Record<string, Record<string, unknown>> }).chains,
    ).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "labels" in parsed &&
    typeof (parsed as { labels: unknown }).labels === "object"
  ) {
    // Simple format: { chainId, labels: { address: entry } }
    return Object.keys((parsed as { labels: Record<string, unknown> }).labels)
      .length;
  }
  return 0;
}
