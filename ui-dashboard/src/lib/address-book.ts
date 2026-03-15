/**
 * Pure helpers for address book row composition.
 * Shared between page.tsx and tests so both always exercise the same logic.
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
 * Merges contract rows (from all networks) and custom rows (from selected
 * network only). Custom rows take precedence over contract rows for the same
 * (selectedNetworkId, address) pair; contract rows from other networks are
 * always kept.
 */
export function buildAddressBookRows(
  contractRows: AddressBookRow[],
  customRows: AddressBookRow[],
  selectedNetworkId: string,
): AddressBookRow[] {
  const customKeysOnSelectedNet = new Set(
    customRows.map((r) => `${selectedNetworkId}:${r.address}`),
  );
  const filteredContractRows = contractRows.filter(
    (r) => !customKeysOnSelectedNet.has(`${r.network?.id ?? ""}:${r.address}`),
  );
  return [...customRows, ...filteredContractRows];
}

/**
 * Returns true when the row should be displayed as a custom label.
 * isCustomLabel() is scoped to the selected network, so it is only consulted
 * for rows on that network to avoid false positives on other chains.
 */
export function resolveIsCustom(
  row: AddressBookRow,
  selectedNetworkId: string,
  isCustomLabel: (address: string) => boolean,
): boolean {
  const isOnSelectedNetwork =
    row.network === null || row.network.id === selectedNetworkId;
  return row.isCustom || (isOnSelectedNetwork && isCustomLabel(row.address));
}

/**
 * Returns true when this row can be edited on the current network.
 * False for contract rows from non-selected networks — editing would write
 * to the wrong Redis chain hash via the chain-scoped AddressLabelEditor.
 */
export function resolveCanEdit(
  row: AddressBookRow,
  selectedNetworkId: string,
): boolean {
  return row.network === null || row.network.id === selectedNetworkId;
}
