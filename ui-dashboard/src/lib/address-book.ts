/**
 * Pure helpers for address book row composition.
 * Shared between page.tsx and tests so both always exercise the same logic.
 *
 * IMPORTANT: custom labels are persisted and fetched by scope — either
 * `"global"` (cross-chain) or a specific chainId (chain-scoped). Two network
 * configs can share the same chainId (e.g. "celo-mainnet" and
 * "celo-mainnet-local" both have chainId 42220). All scoping here uses scope.
 *
 * Address comparisons are always case-insensitive (toLowerCase) because
 * @mento-protocol/contracts uses checksummed mixed-case addresses while Redis
 * stores lowercase addresses.
 */

import type { Scope } from "@/lib/address-labels-shared";
import type { Network } from "@/lib/networks";

export type AddressBookRow = {
  key: string;
  address: string;
  name: string;
  tags: string[];
  isCustom: boolean;
  /** "global" for cross-chain customs, chainId for per-chain customs + contracts. */
  scope: Scope;
  /**
   * Display network. For per-chain rows (scope: chainId) this is the row's
   * network. For global rows this is a display placeholder (e.g. the default
   * or current network) — callers should key rendering on `scope === "global"`
   * rather than assuming `network` reflects the entry's storage scope.
   */
  network: Network;
};

/**
 * Merge contract rows and custom rows into a single de-duped list.
 *
 * Dedupe rule: a per-chain custom row suppresses the contract row at the
 * same `(chainId, address)`. Global custom rows do NOT suppress per-chain
 * contract rows — they render alongside them in the table ("All chains"
 * pill for the custom row, per-chain pills for each contract row).
 */
export function buildAddressBookRows(
  contractRows: AddressBookRow[],
  customRows: AddressBookRow[],
): AddressBookRow[] {
  const perChainCustomKeys = new Set(
    customRows
      .filter((r) => r.scope !== "global")
      .map((r) => `${r.scope}:${r.address.toLowerCase()}`),
  );
  const filteredContractRows = contractRows.filter(
    (r) => !perChainCustomKeys.has(`${r.scope}:${r.address.toLowerCase()}`),
  );
  return [...customRows, ...filteredContractRows];
}

/**
 * Canonical key used by the import API when persisting a label.
 * - scope is `"global"` or the chainId parsed as a decimal integer
 * - address is lowercased (so checksummed and lowercase forms merge)
 */
function importKey(scope: Scope | string | number, address: string): string {
  const scopeKey = scope === "global" ? "global" : Number(scope);
  return `${scopeKey}:${address.toLowerCase()}`;
}

/**
 * Count the number of distinct labels that will be persisted from a parsed
 * import payload. Normalises all three formats to the same canonical
 * (scope, address.toLowerCase()) key used by the import API so that the
 * success toast never over-reports.
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
    // Snapshot format: { exportedAt, global?, chains: { chainId: {...} } }
    const snapshot = parsed as { chains?: unknown; global?: unknown };

    if (
      typeof snapshot.global === "object" &&
      snapshot.global !== null &&
      !Array.isArray(snapshot.global)
    ) {
      for (const address of Object.keys(
        snapshot.global as Record<string, unknown>,
      )) {
        keys.add(importKey("global", address));
      }
    }

    if (
      typeof snapshot.chains === "object" &&
      snapshot.chains !== null &&
      !Array.isArray(snapshot.chains)
    ) {
      for (const [chainId, entries] of Object.entries(
        snapshot.chains as Record<string, unknown>,
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
