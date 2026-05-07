/**
 * Unit tests for the lib helpers extracted in PR #288.
 *
 * Companion to `__tests__/AddressBookClient.test.tsx` (UI-level
 * characterization) and `__tests__/row-composition.test.ts` (the merge/dedupe
 * helper in `@/lib/address-book`). This file covers the four pure helpers in
 * `address-book-rows.ts` directly, so the lib has its own safety net
 * independent of the React rendering layer.
 *
 * Each test pins a distinct branch / fallback / edge case — see the
 * BACKLOG.md entry "Follow-ups deferred from PR #288" for the rationale.
 */

import { describe, it, expect, vi } from "vitest";
import type { AddressEntryRow } from "@/components/address-labels-provider";
import type { Network } from "@/lib/networks";

// ---------------------------------------------------------------------------
// NETWORKS mock
// ---------------------------------------------------------------------------
//
// Why not import the real NETWORKS map?
// - `isConfiguredNetworkId` defaults to `false` for every network under vitest
//   because the env-derived `hasuraUrl`s are empty. With the real map,
//   `buildContractRows()` would always return `[]` and we couldn't observe
//   the row-building branches.
// - Even when stubbed-configured, the real map's `addressLabels` carry
//   production labels for Celo + Monad — those would bleed into every
//   "expected row count" assertion below.
//
// The mock seeds two synthetic networks (one chain configured, one with no
// `addressLabels` to exercise the empty-network branch) and pins the chainIds
// so `networkForChainId` results are deterministic for `buildCustomRows`.

vi.mock("@/lib/networks", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/networks")>("@/lib/networks");

  const fakeCelo: Network = {
    id: "celo-mainnet",
    label: "Celo Mainnet (test)",
    chainId: 42220,
    contractsNamespace: null,
    hasuraUrl: "https://example/celo",
    hasuraSecret: "",
    explorerBaseUrl: "https://example.com",
    tokenSymbols: {},
    addressLabels: {
      "0xcccccccccccccccccccccccccccccccccccccccc": "ContractC",
      "0xdddddddddddddddddddddddddddddddddddddddd": "ContractD",
    },
    local: false,
    testnet: false,
    hasVirtualPools: false,
  };

  const fakeMonad: Network = {
    id: "monad-mainnet",
    label: "Monad Mainnet (test)",
    chainId: 143,
    contractsNamespace: null,
    hasuraUrl: "https://example/monad",
    hasuraSecret: "",
    explorerBaseUrl: "https://example.com",
    tokenSymbols: {},
    // Empty — exercises the "configured network with no labels" branch
    // where `Object.entries(addressLabels)` yields nothing.
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: false,
  };

  const fakeNetworks = {
    "celo-mainnet": fakeCelo,
    "monad-mainnet": fakeMonad,
  } as unknown as typeof actual.NETWORKS;

  return {
    ...actual,
    NETWORKS: fakeNetworks,
    NETWORK_IDS: ["celo-mainnet", "monad-mainnet"],
    DEFAULT_NETWORK: "celo-mainnet",
    isConfiguredNetworkId: (v: string) =>
      v === "celo-mainnet" || v === "monad-mainnet",
    networkForChainId: (chainId: number | null | undefined) => {
      if (chainId === 42220) return fakeCelo;
      if (chainId === 143) return fakeMonad;
      return null;
    },
  };
});

// ---- Imports under test ----------------------------------------------------
//
// Imported AFTER `vi.mock` so vitest applies the mock to transitive
// `@/lib/networks` references inside `address-book-rows.ts`.

import {
  buildContractRows,
  buildCustomRows,
  filterRows,
  unknownChainNetwork,
  type AddressRow,
} from "@/app/address-book/_lib/address-book-rows";
import { NETWORKS, DEFAULT_NETWORK } from "@/lib/networks";

// ---- Helpers ---------------------------------------------------------------

function customEntry(
  overrides: Partial<AddressEntryRow> = {},
): AddressEntryRow {
  return {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scope: "global",
    name: "Custom Whale",
    tags: ["whale"],
    notes: undefined,
    isPublic: false,
    source: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function row(overrides: Partial<AddressRow> = {}): AddressRow {
  return {
    key: "test:0xaaa",
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Whale Alice",
    tags: ["cex"],
    isCustom: false,
    scope: 42220,
    network: NETWORKS["celo-mainnet"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildContractRows
// ---------------------------------------------------------------------------

describe("buildContractRows", () => {
  it("emits one row per (chainId, address) for every configured network", () => {
    const rows = buildContractRows();
    // Celo seeds ContractC + ContractD; Monad has no labels.
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["ContractC", "ContractD"]);
  });

  it("marks every row as a non-custom contract row with chainId scope", () => {
    const rows = buildContractRows();
    for (const r of rows) {
      expect(r.isCustom).toBe(false);
      expect(r.scope).toBe(42220);
      expect(r.tags).toEqual([]);
      expect(r.network.id).toBe("celo-mainnet");
    }
  });

  it("returns no rows for a network with empty addressLabels", () => {
    // The Monad fixture is configured but has no addressLabels — its branch
    // through Object.entries yields nothing, so no rows should surface for it.
    const rows = buildContractRows();
    expect(rows.every((r) => r.network.id !== "monad-mainnet")).toBe(true);
  });

  it("dedupes the same (chainId, address) across networks (case-insensitive)", () => {
    // Add a duplicate of ContractC under different casing on the same chain
    // (via Monad which shares no chainId — so we use Celo with mixed case).
    const original = NETWORKS["celo-mainnet"].addressLabels;
    NETWORKS["celo-mainnet"].addressLabels = {
      "0xcccccccccccccccccccccccccccccccccccccccc": "ContractC",
      "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC": "ContractC mixed",
      "0xdddddddddddddddddddddddddddddddddddddddd": "ContractD",
    };
    try {
      const rows = buildContractRows();
      // The dedupe key is `${chainId}:${address.toLowerCase()}` — the
      // mixed-case duplicate must collapse into the first entry.
      expect(rows).toHaveLength(2);
    } finally {
      NETWORKS["celo-mainnet"].addressLabels = original;
    }
  });
});

// ---------------------------------------------------------------------------
// buildCustomRows
// ---------------------------------------------------------------------------

describe("buildCustomRows", () => {
  const displayNet = NETWORKS["celo-mainnet"];

  it("returns an empty array when no custom entries are provided", () => {
    expect(buildCustomRows([], displayNet)).toEqual([]);
  });

  it("renders a global scope entry as a single 'global' row using the display network", () => {
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          scope: "global",
          name: "Cross-chain Whale",
        }),
      ],
      displayNet,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("global");
    expect(rows[0].isCustom).toBe(true);
    expect(rows[0].network).toBe(displayNet);
    expect(rows[0].key).toBe(
      "custom:global:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows[0].name).toBe("Cross-chain Whale");
  });

  it("renders a per-chain entry as a chain-scoped row resolved via networkForChainId", () => {
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          scope: 42220,
          name: "Celo-only Whale",
        }),
      ],
      displayNet,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe(42220);
    expect(rows[0].network.id).toBe("celo-mainnet");
    expect(rows[0].key).toBe(
      "custom:42220:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("falls back to a synthetic network when the chainId is not in the configured map", () => {
    // Legacy testnet rows still living in Redis after the network was retired:
    // `networkForChainId` returns null, and the helper must substitute the
    // unknown-chain placeholder so the row stays visible (and deletable) in
    // the UI instead of vanishing.
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          scope: 999999,
          name: "Orphaned testnet entry",
        }),
      ],
      displayNet,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].network.label).toBe("Chain 999999");
    expect(rows[0].network.chainId).toBe(999999);
    expect(rows[0].network.explorerBaseUrl).toBe("");
  });

  it("propagates source / createdAt / updatedAt / tags onto the rendered row", () => {
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          scope: "global",
          source: "arkham",
          tags: ["enriched"],
          createdAt: "2026-02-02T00:00:00.000Z",
          updatedAt: "2026-02-03T00:00:00.000Z",
        }),
      ],
      displayNet,
    );
    expect(rows[0].source).toBe("arkham");
    expect(rows[0].tags).toEqual(["enriched"]);
    expect(rows[0].createdAt).toBe("2026-02-02T00:00:00.000Z");
    expect(rows[0].updatedAt).toBe("2026-02-03T00:00:00.000Z");
  });

  it("emits one row per custom entry without merging across scopes", () => {
    // A global custom + a per-chain custom for the same address coexist —
    // dedupe is the merge helper's job (`buildAddressBookRows` in lib),
    // not this builder's. Pinning prevents a regression that silently drops
    // one of the two when their addresses match.
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          scope: "global",
        }),
        customEntry({
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          scope: 42220,
        }),
      ],
      displayNet,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.scope).sort()).toEqual([42220, "global"]);
  });
});

// ---------------------------------------------------------------------------
// filterRows
// ---------------------------------------------------------------------------

describe("filterRows", () => {
  const contractRow = row({
    key: "celo-mainnet:0xCCC",
    address: "0xcccccccccccccccccccccccccccccccccccccccc",
    name: "ContractC",
    tags: [],
    isCustom: false,
    scope: 42220,
    network: NETWORKS["celo-mainnet"],
  });
  const customRowGlobal = row({
    key: "custom:global:0xaaa",
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Whale Alice",
    tags: ["cex"],
    isCustom: true,
    scope: "global",
    network: NETWORKS["celo-mainnet"],
  });
  const customRowArkham = row({
    key: "custom:42220:0xbbb",
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    name: "Arkham Entry",
    tags: [],
    isCustom: true,
    source: "arkham",
    scope: 42220,
    network: NETWORKS["celo-mainnet"],
  });
  const customRowMiniPay = row({
    key: "custom:42220:0xddd",
    address: "0xdddddddddddddddddddddddddddddddddddddddd",
    name: "MiniPay user",
    tags: [],
    isCustom: true,
    source: "minipay",
    scope: 42220,
    network: NETWORKS["celo-mainnet"],
  });
  const all = [contractRow, customRowGlobal, customRowArkham, customRowMiniPay];

  it("returns the input unchanged when the search string is empty", () => {
    expect(filterRows(all, "")).toBe(all);
  });

  it("matches the address substring case-insensitively", () => {
    // Mixed-case input must lower-case both sides before comparing.
    const result = filterRows(all, "0xAAAAAAAA");
    expect(result.map((r) => r.key)).toEqual(["custom:global:0xaaa"]);
  });

  it("matches by name substring", () => {
    const result = filterRows(all, "Whale Alice");
    expect(result.map((r) => r.key)).toEqual(["custom:global:0xaaa"]);
  });

  it("matches by tag substring", () => {
    const result = filterRows(all, "cex");
    expect(result.map((r) => r.key)).toEqual(["custom:global:0xaaa"]);
  });

  it("matches by chain text 'all chains' for global-scope rows", () => {
    const result = filterRows(all, "all chains");
    expect(result.map((r) => r.key)).toEqual(["custom:global:0xaaa"]);
  });

  it("matches by chain text using the network label for chain-scoped rows", () => {
    // Chain-scoped rows expose their network label as searchable text.
    const result = filterRows(all, "celo mainnet");
    // ContractC + the two chain-scoped customs all live on Celo; the global
    // custom uses "all chains" for chain text, so it must be excluded.
    expect(result.map((r) => r.key).sort()).toEqual([
      "celo-mainnet:0xCCC",
      "custom:42220:0xbbb",
      "custom:42220:0xddd",
    ]);
  });

  it("matches by source-badge text 'contract' for non-custom rows", () => {
    const result = filterRows(all, "contract");
    // Both the contract row's name ("ContractC") and its sourceText
    // ("contract") match — but no other row's sourceText is "contract".
    expect(result.map((r) => r.key)).toEqual(["celo-mainnet:0xCCC"]);
  });

  it("matches by source-badge text 'arkham' for arkham-sourced rows", () => {
    const result = filterRows(all, "arkham");
    // "arkham" ONLY matches the arkham-sourced row — its name happens to
    // contain "Arkham" too, so we also pin that the badge branch fires
    // (vs. a different row sneaking in via name).
    expect(result.map((r) => r.key)).toEqual(["custom:42220:0xbbb"]);
  });

  it("matches by source-badge text 'minipay' for minipay-sourced rows", () => {
    const result = filterRows(all, "minipay");
    expect(result.map((r) => r.key)).toEqual(["custom:42220:0xddd"]);
  });

  it("matches by source-badge text 'custom' for plain user rows but not for contract or sourced rows", () => {
    // The default branch in sourceText (not arkham, not minipay -> "custom").
    // The global custom row has no `source` set, so it must surface; the
    // contract row's sourceText is "contract" and must NOT match.
    const result = filterRows(all, "custom");
    expect(result.map((r) => r.key).sort()).toEqual(["custom:global:0xaaa"]);
  });

  it("returns an empty array when no row matches", () => {
    const result = filterRows(all, "nonexistent-substring-zzz");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// unknownChainNetwork
// ---------------------------------------------------------------------------

describe("unknownChainNetwork", () => {
  it("returns a Network with the chainId echoed back as `Chain N` label", () => {
    const net = unknownChainNetwork(987654);
    expect(net.chainId).toBe(987654);
    expect(net.label).toBe("Chain 987654");
  });

  it("uses DEFAULT_NETWORK as the placeholder `id` so the IndexerNetworkId union stays valid", () => {
    // The `id` field is documented as a synthetic placeholder; pinning it
    // catches a refactor that hand-codes an arbitrary string and breaks the
    // typed union contract.
    const net = unknownChainNetwork(123);
    expect(net.id).toBe(DEFAULT_NETWORK);
  });

  it("uses empty strings for hasuraUrl + hasuraSecret + explorerBaseUrl as fallback sentinels", () => {
    // explorerBaseUrl="" specifically triggers the "no explorer" render path
    // in AddressTableRow — replacing it with any non-empty placeholder would
    // surface a broken relative explorer link.
    const net = unknownChainNetwork(42);
    expect(net.hasuraUrl).toBe("");
    expect(net.hasuraSecret).toBe("");
    expect(net.explorerBaseUrl).toBe("");
  });

  it("returns empty token / address label maps and a non-local non-testnet flag triple", () => {
    const net = unknownChainNetwork(42);
    expect(net.tokenSymbols).toEqual({});
    expect(net.addressLabels).toEqual({});
    expect(net.local).toBe(false);
    expect(net.testnet).toBe(false);
    expect(net.hasVirtualPools).toBe(false);
    expect(net.contractsNamespace).toBeNull();
  });
});
