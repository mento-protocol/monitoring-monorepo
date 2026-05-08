import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type Network,
} from "@/lib/networks";
import {
  isArkhamSourced,
  isMiniPaySourced,
  type AddressEntry,
} from "@/lib/address-labels-shared";
import type { AddressBookRow } from "@/lib/address-book";
import type { AddressEntryRow } from "@/components/address-labels-provider";

export type AddressRow = AddressBookRow;

/**
 * Look up a contract-name pre-fill for the address-label form. Walks every
 * configured network's static `addressLabels` registry case-insensitively.
 *
 * Same address on multiple chains generally has the same contract name
 * (deterministic deploys); first match wins, which is fine for editor pre-fill
 * because the user can always override.
 *
 * Returns `undefined` for addresses that aren't in any contract registry —
 * the form then renders as a fresh custom-label entry.
 *
 * Shared between the modal flow (`AddressBookClient`) and the detail page
 * (`/address-book/[address]`) so both surfaces preserve contract names when a
 * user opens the form for a known contract row that doesn't yet have a custom
 * label.
 */
export function findContractInitial(address: string): AddressEntry | undefined {
  const lower = address.toLowerCase();
  for (const net of Object.values(NETWORKS)) {
    for (const [registered, name] of Object.entries(net.addressLabels)) {
      if (registered.toLowerCase() === lower) {
        return {
          name,
          tags: [],
          updatedAt: new Date().toISOString(),
        };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/**
 * Build contract rows from every configured network — one row per
 * (chainId, address), deduped by key. Contract rows are still per-chain
 * (each network's static `addressLabels` registry).
 */
export function buildContractRows(): AddressRow[] {
  const rows: AddressRow[] = [];
  const seen = new Set<string>();
  for (const id of NETWORK_IDS.filter(isConfiguredNetworkId)) {
    const net = NETWORKS[id];
    for (const [address, name] of Object.entries(net.addressLabels)) {
      const key = `${net.chainId}:${address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key: `${id}:${address}`,
        address,
        name,
        tags: [],
        isCustom: false,
        network: net,
      });
    }
  }
  return rows;
}

/**
 * Build custom rows from the provider's entry list. Custom labels are
 * address-keyed only — one row per address. The `globalDisplayNetwork`
 * argument supplies a placeholder Network so explorer-link helpers don't
 * need to special-case "no chain" rows; the row's chain pill renders as
 * "All chains" regardless.
 */
export function buildCustomRows(
  customEntries: AddressEntryRow[],
  globalDisplayNetwork: Network,
): AddressRow[] {
  return customEntries.map((r) => ({
    key: `custom:${r.address}`,
    address: r.address,
    name: r.name,
    tags: r.tags,
    isCustom: true,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    network: globalDisplayNetwork,
  }));
}

/**
 * Merge + filter rows for display. Applies the search filter using the same
 * source-text logic the SOURCE badge renderer uses — handles both new-shape
 * (source) and legacy (tag-only) rows.
 *
 * The caller is responsible for calling `buildAddressBookRows(contractRows,
 * customRows)` before passing the merged list in, so deduplication/ordering
 * invariants remain in the shared helper.
 */
export function filterRows(rows: AddressRow[], search: string): AddressRow[] {
  if (!search) return rows;
  const q = search.toLowerCase();
  return rows.filter((row) => {
    const chainText = row.isCustom ? "all chains" : row.network.label;
    // Match the rendered SOURCE badge text so users can search by it
    // (e.g. "arkham" no longer lives in tags after the source-field
    // migration; without this, the search box can't surface those rows).
    // Use the same `isArkhamSourced` dual-check the badge renderer uses
    // — it handles both new-shape (source) and legacy (tag-only) rows.
    const sourceText = row.isCustom
      ? isArkhamSourced({ source: row.source, tags: row.tags })
        ? "arkham"
        : isMiniPaySourced({ source: row.source })
          ? "minipay"
          : "custom"
      : "contract";
    return (
      row.address.toLowerCase().includes(q) ||
      row.name.toLowerCase().includes(q) ||
      chainText.toLowerCase().includes(q) ||
      row.tags.some((t) => t.toLowerCase().includes(q)) ||
      sourceText.includes(q)
    );
  });
}
