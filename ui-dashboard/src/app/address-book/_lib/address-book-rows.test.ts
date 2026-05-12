/**
 * Unit tests for the lib helpers in `address-book-rows.ts`.
 *
 * Companion to `__tests__/AddressBookClient.test.tsx` (UI-level
 * characterization) and `__tests__/row-composition.test.ts` (the merge/dedupe
 * helper in `@/lib/address-book`). This file covers the three pure helpers in
 * `address-book-rows.ts` directly, so the lib has its own safety net
 * independent of the React rendering layer.
 *
 * Post-#332: labels are address-keyed only — no chain/global scope. Custom
 * rows always render with a `globalDisplayNetwork` placeholder; the chain
 * pill renders as "All chains" via `isCustom`. Contract rows are still
 * per-chain (each network's static `addressLabels` registry).
 */

import { describe, it, expect, vi } from "vitest";
import type { AddressEntryRow } from "@/components/address-labels-provider";
import type { Network } from "@/lib/networks";

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
    // Empty — exercises the "configured network with no labels" branch.
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
  };
});

import {
  buildContractRows,
  buildCustomRows,
  buildReportOnlyRows,
  filterRows,
  findContractInitial,
  type AddressRow,
} from "@/app/address-book/_lib/address-book-rows";
import { NETWORKS } from "@/lib/networks";

function customEntry(
  overrides: Partial<AddressEntryRow> = {},
): AddressEntryRow {
  return {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["ContractC", "ContractD"]);
  });

  it("marks every row as a non-custom contract row attached to its network", () => {
    const rows = buildContractRows();
    for (const r of rows) {
      expect(r.isCustom).toBe(false);
      expect(r.tags).toEqual([]);
      expect(r.network.id).toBe("celo-mainnet");
    }
  });

  it("returns no rows for a network with empty addressLabels", () => {
    const rows = buildContractRows();
    expect(rows.every((r) => r.network.id !== "monad-mainnet")).toBe(true);
  });

  it("dedupes the same (chainId, address) across networks (case-insensitive)", () => {
    const original = NETWORKS["celo-mainnet"].addressLabels;
    NETWORKS["celo-mainnet"].addressLabels = {
      "0xcccccccccccccccccccccccccccccccccccccccc": "ContractC",
      "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC": "ContractC mixed",
      "0xdddddddddddddddddddddddddddddddddddddddd": "ContractD",
    };
    try {
      const rows = buildContractRows();
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

  it("renders a custom entry as a single row using the display network placeholder", () => {
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          name: "Cross-chain Whale",
        }),
      ],
      displayNet,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
    expect(rows[0].network).toBe(displayNet);
    expect(rows[0].key).toBe(
      "custom:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows[0].name).toBe("Cross-chain Whale");
  });

  it("propagates source / createdAt / updatedAt / tags onto the rendered row", () => {
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
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

  it("emits one row per custom entry, address-keyed (no merging)", () => {
    // Two different addresses must each produce a row. Same-address dedupe
    // is the merge helper's job (`buildAddressBookRows` in lib), not this
    // builder's.
    const rows = buildCustomRows(
      [
        customEntry({
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
        customEntry({
          address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      ],
      displayNet,
    );
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildReportOnlyRows
// ---------------------------------------------------------------------------

describe("buildReportOnlyRows", () => {
  const displayNet = NETWORKS["celo-mainnet"];
  const reportOnly = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  it("emits a reachable all-chain row for a report-only address", () => {
    const rows = buildReportOnlyRows([reportOnly], displayNet, []);
    expect(rows).toEqual([
      expect.objectContaining({
        key: `report:${reportOnly}`,
        address: reportOnly,
        name: "Forensic report",
        tags: [],
        kind: "report",
        isCustom: false,
        network: displayNet,
      }),
    ]);
  });

  it("dedupes against existing contract and custom rows", () => {
    const rows = buildReportOnlyRows(
      [
        "0xcccccccccccccccccccccccccccccccccccccccc",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        reportOnly,
        reportOnly.toUpperCase(),
        "not-an-address",
      ],
      displayNet,
      [
        row({
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          kind: "contract",
        }),
        row({
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          kind: "custom",
          isCustom: true,
        }),
      ],
    );
    expect(rows.map((r) => r.address)).toEqual([reportOnly]);
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
    network: NETWORKS["celo-mainnet"],
  });
  const customRowPlain = row({
    key: "custom:0xaaa",
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Whale Alice",
    tags: ["cex"],
    isCustom: true,
    network: NETWORKS["celo-mainnet"],
  });
  const customRowArkham = row({
    key: "custom:0xbbb",
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    name: "Arkham Entry",
    tags: [],
    isCustom: true,
    source: "arkham",
    network: NETWORKS["celo-mainnet"],
  });
  const customRowMiniPay = row({
    key: "custom:0xddd",
    address: "0xdddddddddddddddddddddddddddddddddddddddd",
    name: "MiniPay user",
    tags: [],
    isCustom: true,
    source: "minipay",
    network: NETWORKS["celo-mainnet"],
  });
  const reportRow = row({
    key: "report:0xeee",
    address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    name: "Forensic report",
    tags: [],
    kind: "report",
    isCustom: false,
    network: NETWORKS["celo-mainnet"],
  });
  const all = [
    contractRow,
    customRowPlain,
    customRowArkham,
    customRowMiniPay,
    reportRow,
  ];

  it("returns the input unchanged when the search string is empty", () => {
    expect(filterRows(all, "")).toBe(all);
  });

  it("matches the address substring case-insensitively", () => {
    const result = filterRows(all, "0xAAAAAAAA");
    expect(result.map((r) => r.key)).toEqual(["custom:0xaaa"]);
  });

  it("matches by name substring", () => {
    const result = filterRows(all, "Whale Alice");
    expect(result.map((r) => r.key)).toEqual(["custom:0xaaa"]);
  });

  it("matches by tag substring", () => {
    const result = filterRows(all, "cex");
    expect(result.map((r) => r.key)).toEqual(["custom:0xaaa"]);
  });

  it("matches 'all chains' against every custom row", () => {
    const result = filterRows(all, "all chains");
    // Every custom/report-only row reports "all chains" as its chain text.
    expect(result.map((r) => r.key).sort()).toEqual([
      "custom:0xaaa",
      "custom:0xbbb",
      "custom:0xddd",
      "report:0xeee",
    ]);
  });

  it("matches by chain text using the network label for contract rows", () => {
    const result = filterRows(all, "celo mainnet");
    // Only contract rows expose their network label as searchable chain text.
    expect(result.map((r) => r.key)).toEqual(["celo-mainnet:0xCCC"]);
  });

  it("matches by source-badge text 'contract' for non-custom rows", () => {
    const result = filterRows(all, "contract");
    expect(result.map((r) => r.key)).toEqual(["celo-mainnet:0xCCC"]);
  });

  it("matches by source-badge text 'report' for report-only rows", () => {
    const result = filterRows(all, "report");
    expect(result.map((r) => r.key)).toEqual(["report:0xeee"]);
  });

  it("matches by source-badge text 'arkham' for arkham-sourced rows", () => {
    const result = filterRows(all, "arkham");
    expect(result.map((r) => r.key)).toEqual(["custom:0xbbb"]);
  });

  it("matches by source-badge text 'minipay' for minipay-sourced rows", () => {
    const result = filterRows(all, "minipay");
    expect(result.map((r) => r.key)).toEqual(["custom:0xddd"]);
  });

  it("matches by source-badge text 'custom' for plain user rows", () => {
    const result = filterRows(all, "custom");
    expect(result.map((r) => r.key)).toEqual(["custom:0xaaa"]);
  });

  it("returns an empty array when no row matches", () => {
    const result = filterRows(all, "nonexistent-substring-zzz");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findContractInitial
// ---------------------------------------------------------------------------

describe("findContractInitial", () => {
  it("returns a pre-filled entry for a registered contract address", () => {
    const initial = findContractInitial(
      "0xcccccccccccccccccccccccccccccccccccccccc",
    );
    expect(initial).toBeDefined();
    expect(initial?.name).toBe("ContractC");
    expect(initial?.tags).toEqual([]);
    expect(typeof initial?.updatedAt).toBe("string");
  });

  it("matches case-insensitively against the registry", () => {
    const initial = findContractInitial(
      "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    );
    expect(initial?.name).toBe("ContractC");
  });

  it("returns undefined for an address that isn't in any registry", () => {
    const initial = findContractInitial(
      "0xfffffffffffffffffffffffffffffffffffffffe",
    );
    expect(initial).toBeUndefined();
  });
});
