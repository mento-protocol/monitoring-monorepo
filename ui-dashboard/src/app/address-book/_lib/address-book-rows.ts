/**
 * Row-composition helpers for the address-book page.
 *
 * Extracted from AddressBookClient.tsx (useMemo callbacks at lines 87-182
 * pre-extraction). Each function is pure so it can be wrapped in `useMemo`
 * by the caller without dragging in hook plumbing.
 *
 * The existing `buildAddressBookRows` helper in `@/lib/address-book` (covered
 * by row-composition.test.ts) is intentionally left in its current location
 * and is called here via the caller's `allRows` memo.
 */

import {
  NETWORKS,
  NETWORK_IDS,
  DEFAULT_NETWORK,
  isConfiguredNetworkId,
  networkForChainId,
  type Network,
} from "@/lib/networks";
import {
  isArkhamSourced,
  isMiniPaySourced,
  type Scope,
} from "@/lib/address-labels-shared";
import type { AddressBookRow } from "@/lib/address-book";
import type { AddressEntryRow } from "@/components/address-labels-provider";

export type AddressRow = AddressBookRow;

// `networkForChainId` is the canonical lookup from `@/lib/networks`; this
// module is its caller for legacy-chain fallback. The caller (`AddressBookClient`)
// imports `networkForChainId` directly from `@/lib/networks` rather than via
// this module so the address-book code shares one source of truth.

// Fall back to a synthetic network for legacy chain scopes (e.g. rows written
// against the now-retired hosted testnet networks). Keeps orphaned entries
// visible so users can delete them rather than having them silently disappear
// from the UI.
export function unknownChainNetwork(chainId: number): Network {
  return {
    // `id` must satisfy the `IndexerNetworkId` union so the Network type is
    // valid. It's never read for unknown-chain rows (scope is the integer
    // chainId; id-based routing never triggers for these), so DEFAULT_NETWORK
    // is a safe placeholder.
    id: DEFAULT_NETWORK,
    label: `Chain ${chainId}`,
    chainId,
    contractsNamespace: null,
    hasuraUrl: "",
    hasuraSecret: "",
    // Empty string triggers the "no explorer" render path in AddressTableRow
    // — address renders as plain text instead of a broken relative link.
    explorerBaseUrl: "",
    tokenSymbols: {},
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: false,
  };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/**
 * Build contract rows from every configured network — one row per
 * (chainId, address), deduped by key.
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
        scope: net.chainId,
        network: net,
      });
    }
  }
  return rows;
}

/**
 * Build custom rows from the provider's entry list.
 *
 * Global entries render as a single "All chains" row using `globalDisplayNetwork`
 * as the display network. Per-chain entries render as one row per chain, with
 * a synthetic fallback network for unrecognised chainIds.
 */
export function buildCustomRows(
  customEntries: AddressEntryRow[],
  globalDisplayNetwork: Network,
): AddressRow[] {
  return customEntries.flatMap((r) => {
    if (r.scope === "global") {
      return [
        {
          key: `custom:global:${r.address}`,
          address: r.address,
          name: r.name,
          tags: r.tags,
          isCustom: true,
          source: r.source,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          scope: "global" as Scope,
          network: globalDisplayNetwork,
        },
      ];
    }
    // Fall back to a synthetic network for legacy chain scopes (e.g. rows
    // written against the now-retired hosted testnet networks). Keeps
    // orphaned entries visible so users can delete them rather than
    // having them silently disappear from the UI.
    const net = networkForChainId(r.scope) ?? unknownChainNetwork(r.scope);
    return [
      {
        key: `custom:${r.scope}:${r.address}`,
        address: r.address,
        name: r.name,
        tags: r.tags,
        isCustom: true,
        source: r.source,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        scope: r.scope,
        network: net,
      },
    ];
  });
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
    const chainText = row.scope === "global" ? "all chains" : row.network.label;
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
