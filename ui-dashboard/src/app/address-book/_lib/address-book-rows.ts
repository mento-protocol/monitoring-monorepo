import {
  NETWORKS,
  NETWORK_IDS,
  isConfiguredNetworkId,
  type Network,
} from "@/lib/networks";
import { isValidAddress } from "@/lib/format";
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
 * Returns `undefined` when:
 *   - no configured network has a label for this address, OR
 *   - configured networks DISAGREE on the name (e.g.
 *     `0x0dd57f6f...` is `Yield Split` on Celo and `ProtocolFeeRecipient`
 *     on Monad). The detail URL is chain-agnostic so we can't tell which
 *     chain the user clicked from. Pre-filling with first-match-wins
 *     would let a save on the Monad row persist `Yield Split` as the
 *     GLOBAL custom name — suppressing the Monad contract row in the
 *     index under Celo's label. Better to render an empty form and let
 *     the user type the right name for their context.
 *
 * Shared between the modal flow (`AddressBookClient`) and the detail page
 * (`/address-book/[address]`) so both surfaces preserve contract names when a
 * user opens the form for a known contract row that doesn't yet have a custom
 * label.
 */
export function findContractInitial(address: string): AddressEntry | undefined {
  const matched = collectContractMatches(address);
  if (matched.size !== 1) return undefined;
  const [name] = matched;
  return {
    name,
    tags: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * True when `address` is registered as a contract under TWO OR MORE
 * different names across configured networks. The detail URL is
 * chain-agnostic, so we can't infer which row the user clicked from —
 * the form must require an explicit name to avoid persisting a
 * tag-only / blank-name custom label that would suppress every
 * disagreeing contract row in the index under the wrong (or empty)
 * display name.
 */
export function hasAmbiguousContractMatches(address: string): boolean {
  return collectContractMatches(address).size > 1;
}

function collectContractMatches(address: string): Set<string> {
  // Filter to the same `isConfiguredNetworkId` set `buildContractRows`
  // uses — devnet / local-only registries carry deployer addresses that
  // are inappropriate to surface on the prod detail page.
  const lower = address.toLowerCase();
  const matchedNames = new Set<string>();
  for (const id of NETWORK_IDS.filter(isConfiguredNetworkId)) {
    const net = NETWORKS[id];
    for (const [registered, name] of Object.entries(net.addressLabels)) {
      if (registered.toLowerCase() === lower) {
        matchedNames.add(name);
      }
    }
  }
  return matchedNames;
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
        kind: "contract",
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
    kind: "custom",
    isCustom: true,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    network: globalDisplayNetwork,
  }));
}

/**
 * Build rows for addresses that have a forensic report but no contract/custom
 * label row. These rows make report-only investigations reachable from the
 * address-book index without pretending a label exists.
 */
export function buildReportOnlyRows(
  reportAddresses: string[],
  globalDisplayNetwork: Network,
  existingRows: AddressRow[],
): AddressRow[] {
  const existingAddresses = new Set(
    existingRows.map((row) => row.address.toLowerCase()),
  );
  const seenReports = new Set<string>();
  return reportAddresses
    .flatMap((address) => {
      const lower = address.toLowerCase();
      if (
        seenReports.has(lower) ||
        existingAddresses.has(lower) ||
        !isValidAddress(lower)
      ) {
        return [];
      }
      seenReports.add(lower);
      return [
        {
          key: `report:${lower}`,
          address: lower,
          name: "Forensic report",
          tags: [],
          kind: "report" as const,
          isCustom: false,
          network: globalDisplayNetwork,
        },
      ];
    })
    .sort((a, b) => a.address.localeCompare(b.address));
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
    const chainText =
      row.isCustom || row.kind === "report" ? "all chains" : row.network.label;
    // Match the rendered SOURCE badge text so users can search by it
    // (e.g. "arkham" no longer lives in tags after the source-field
    // migration; without this, the search box can't surface those rows).
    // Use the same `isArkhamSourced` dual-check the badge renderer uses
    // — it handles both new-shape (source) and legacy (tag-only) rows.
    const sourceText =
      row.kind === "report"
        ? "report"
        : row.isCustom
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
