/**
 * Pure helpers for address book row composition.
 * Shared between page.tsx and tests so both always exercise the same logic.
 *
 * Custom labels are address-keyed only — no chain scope. Static contract
 * rows are still per-chain (each chain has its own NETWORKS.addressLabels
 * registry). A custom label suppresses every contract row for the same
 * address (since the label is one entity, the contract rows would just
 * duplicate the same address with chain pills).
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
  kind?: "contract" | "custom" | "report";
  isCustom: boolean;
  /** Provenance — `"arkham"` for cron-enriched entries, undefined for manual. */
  source?: string;
  /** ISO timestamp of first write; undefined for static contract rows. */
  createdAt?: string;
  /** ISO timestamp of most recent write; undefined for static contract rows. */
  updatedAt?: string;
  /**
   * Display network. Custom rows reuse a default network for explorer-link
   * fallback; contract rows carry their own chain. Callers that need to
   * show a chain pill should branch on `isCustom`.
   */
  network: Network;
};

/**
 * Merge contract rows and custom rows into a single de-duped list.
 *
 * Dedupe rule: a custom row suppresses every contract row for the same
 * address. Custom labels are address-keyed (one entity per address); the
 * per-chain contract registry duplication isn't useful once a custom
 * label exists.
 */
export function buildAddressBookRows(
  contractRows: AddressBookRow[],
  customRows: AddressBookRow[],
): AddressBookRow[] {
  const customAddresses = new Set(
    customRows.map((r) => r.address.toLowerCase()),
  );
  const filteredContractRows = contractRows.filter(
    (r) => !customAddresses.has(r.address.toLowerCase()),
  );
  return [...customRows, ...filteredContractRows];
}

/**
 * Count the number of distinct labels that will be persisted from a parsed
 * import payload. All three import formats normalise to a per-address key,
 * since labels are address-keyed only.
 */
export function countImportLabels(parsed: unknown): number {
  const addresses = new Set<string>();

  if (Array.isArray(parsed)) {
    // Gnosis Safe format: Array<{ address, chainId?, name }>
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).address === "string"
      ) {
        addresses.add((entry as Record<string, string>).address.toLowerCase());
      }
    }
    return addresses.size;
  }

  if (typeof parsed === "object" && parsed !== null) {
    // Snapshot format: { exportedAt, addresses?, global?, chains? }
    const snapshot = parsed as {
      addresses?: unknown;
      chains?: unknown;
      global?: unknown;
      labels?: unknown;
    };

    if (
      typeof snapshot.addresses === "object" &&
      snapshot.addresses !== null &&
      !Array.isArray(snapshot.addresses)
    ) {
      for (const address of Object.keys(
        snapshot.addresses as Record<string, unknown>,
      )) {
        addresses.add(address.toLowerCase());
      }
    }

    // Legacy global / chains in old snapshots — both fold into the same
    // per-address key set.
    if (
      typeof snapshot.global === "object" &&
      snapshot.global !== null &&
      !Array.isArray(snapshot.global)
    ) {
      for (const address of Object.keys(
        snapshot.global as Record<string, unknown>,
      )) {
        addresses.add(address.toLowerCase());
      }
    }
    if (
      typeof snapshot.chains === "object" &&
      snapshot.chains !== null &&
      !Array.isArray(snapshot.chains)
    ) {
      for (const entries of Object.values(
        snapshot.chains as Record<string, unknown>,
      )) {
        if (
          typeof entries === "object" &&
          entries !== null &&
          !Array.isArray(entries)
        ) {
          for (const address of Object.keys(entries)) {
            addresses.add(address.toLowerCase());
          }
        }
      }
    }

    // Simple format: { chainId?, labels: { address: entry } } — chainId ignored.
    if (
      typeof snapshot.labels === "object" &&
      snapshot.labels !== null &&
      !Array.isArray(snapshot.labels)
    ) {
      for (const address of Object.keys(snapshot.labels)) {
        addresses.add(address.toLowerCase());
      }
    }
    return addresses.size;
  }

  return 0;
}
