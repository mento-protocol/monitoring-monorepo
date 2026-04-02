/**
 * Tests for address book row composition using the shared helpers from
 * @/lib/address-book — same functions used in page.tsx.
 *
 * Key invariants:
 * - Scoping uses chainId (not network.id) because custom labels are stored
 *   by chainId in Redis. Two network configs can share the same chainId
 *   (e.g. "celo-mainnet-hosted" and "celo-mainnet-local").
 * - Address comparisons are case-insensitive.
 */

import { describe, it, expect } from "vitest";
import {
  buildAddressBookRows,
  resolveIsCustom,
  resolveCanEdit,
  type AddressBookRow,
} from "@/lib/address-book";
import type { Network } from "@/lib/networks";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Same address, different casing (simulates checksummed vs lowercase)
const ADDR_A = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"; // mixed-case
const ADDR_A_LC = "0xabcdef1234567890abcdef1234567890abcdef12"; // lowercase
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Two network IDs sharing the same chainId (hosted + local variant) */
const NET_CELO_HOSTED = makeNet("celo-mainnet-hosted", 42220);
const NET_CELO_LOCAL = makeNet("celo-mainnet-local", 42220); // same chainId!
const NET_MONAD = makeNet("monad-mainnet-hosted", 143);

function makeNet(id: string, chainId: number): Network {
  return {
    id: id as Network["id"],
    label: `Net ${id}`,
    chainId,
    contractsNamespace: null,
    hasuraUrl: `https://${id}.example.com`,
    hasuraSecret: "",
    explorerBaseUrl: "https://example.com",
    tokenSymbols: {},
    addressLabels: {},
    local: false,
    testnet: false,
    hasVirtualPools: false,
  };
}

function contractRow(
  address: string,
  net: Network,
  name = "Contract",
): AddressBookRow {
  return {
    key: `${net.id}:${address.toLowerCase()}`,
    address,
    name,
    tags: [],
    isCustom: false,
    network: net,
  };
}

function customRow(address: string, net: Network): AddressBookRow {
  return {
    key: `custom:${address.toLowerCase()}`,
    address,
    name: "Custom label",
    tags: [],
    isCustom: true,
    network: net,
  };
}

// ---------------------------------------------------------------------------
// buildAddressBookRows
// ---------------------------------------------------------------------------

describe("buildAddressBookRows", () => {
  it("returns all contract rows when no custom labels exist", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO_HOSTED), contractRow(ADDR_B, NET_MONAD)],
      [],
      NET_CELO_HOSTED.chainId,
    );
    expect(rows).toHaveLength(2);
  });

  it("keeps same address from different chains as separate rows", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO_HOSTED), contractRow(ADDR_A, NET_MONAD)],
      [],
      NET_CELO_HOSTED.chainId,
    );
    expect(rows).toHaveLength(2);
  });

  it("hides contract row on selected chain when custom label exists", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO_HOSTED)],
      [customRow(ADDR_A, NET_CELO_HOSTED)],
      NET_CELO_HOSTED.chainId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("does NOT hide contract row from other chain when custom exists on selected", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO_HOSTED), contractRow(ADDR_A, NET_MONAD)],
      [customRow(ADDR_A, NET_CELO_HOSTED)],
      NET_CELO_HOSTED.chainId,
    );
    // Custom + Monad contract row (Celo contract row replaced by custom)
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.network?.chainId === NET_MONAD.chainId)).toBe(
      true,
    );
  });

  it("same-chainId different-networkId: custom on hosted suppresses local contract row", () => {
    // Both NET_CELO_HOSTED and NET_CELO_LOCAL have chainId 42220
    const rows = buildAddressBookRows(
      [
        contractRow(ADDR_A, NET_CELO_HOSTED),
        contractRow(ADDR_A, NET_CELO_LOCAL),
      ],
      [customRow(ADDR_A, NET_CELO_HOSTED)],
      NET_CELO_HOSTED.chainId, // = 42220
    );
    // Both contract rows share chainId 42220, so both are suppressed by the custom label
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("matches addresses case-insensitively (checksummed vs lowercase)", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO_HOSTED)], // checksummed
      [customRow(ADDR_A_LC, NET_CELO_HOSTED)], // lowercase
      NET_CELO_HOSTED.chainId,
    );
    // Should dedupe even though casing differs
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("custom rows come first in the result", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_B, NET_CELO_HOSTED)],
      [customRow(ADDR_A, NET_CELO_HOSTED)],
      NET_CELO_HOSTED.chainId,
    );
    expect(rows[0].isCustom).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveIsCustom
// ---------------------------------------------------------------------------

describe("resolveIsCustom", () => {
  it("contract row on selected chain is NOT marked custom by default", () => {
    const row = contractRow(ADDR_B, NET_CELO_HOSTED);
    expect(resolveIsCustom(row, NET_CELO_HOSTED.chainId, () => false)).toBe(
      false,
    );
  });

  it("contract row on selected chain IS marked custom when isCustomLabel returns true", () => {
    const row = contractRow(ADDR_A, NET_CELO_HOSTED);
    expect(resolveIsCustom(row, NET_CELO_HOSTED.chainId, () => true)).toBe(
      true,
    );
  });

  it("contract row on OTHER chain is NOT marked custom even if address has custom on selected", () => {
    const row = contractRow(ADDR_A, NET_MONAD);
    expect(resolveIsCustom(row, NET_CELO_HOSTED.chainId, () => true)).toBe(
      false,
    );
  });

  it("same-chainId different-networkId: both treated as same chain scope", () => {
    const rowLocal = contractRow(ADDR_A, NET_CELO_LOCAL);
    // isCustomLabel returns true (custom exists on chain 42220)
    expect(resolveIsCustom(rowLocal, NET_CELO_HOSTED.chainId, () => true)).toBe(
      true,
    );
  });

  it("custom row is always marked custom", () => {
    const row = customRow(ADDR_A, NET_CELO_HOSTED);
    expect(resolveIsCustom(row, NET_CELO_HOSTED.chainId, () => false)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveCanEdit
// ---------------------------------------------------------------------------

describe("resolveCanEdit", () => {
  it("allows editing rows on the selected chain", () => {
    expect(
      resolveCanEdit(
        contractRow(ADDR_A, NET_CELO_HOSTED),
        NET_CELO_HOSTED.chainId,
      ),
    ).toBe(true);
  });

  it("disables editing for contract rows on a different chain", () => {
    expect(
      resolveCanEdit(contractRow(ADDR_A, NET_MONAD), NET_CELO_HOSTED.chainId),
    ).toBe(false);
  });

  it("same-chainId different-networkId: both editable on same chain", () => {
    // NET_CELO_LOCAL has chainId 42220 = same as NET_CELO_HOSTED
    expect(
      resolveCanEdit(
        contractRow(ADDR_A, NET_CELO_LOCAL),
        NET_CELO_HOSTED.chainId,
      ),
    ).toBe(true);
  });

  it("allows editing custom rows (network=null)", () => {
    const row: AddressBookRow = {
      key: "custom",
      address: ADDR_A,
      name: "lbl",
      tags: [],
      isCustom: true,
      network: null,
    };
    expect(resolveCanEdit(row, NET_CELO_HOSTED.chainId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countImportLabels
// ---------------------------------------------------------------------------

import { countImportLabels } from "@/lib/address-book";

describe("countImportLabels", () => {
  const addr = "0x" + "a".repeat(40);
  const addr2 = "0x" + "b".repeat(40);

  it("returns 0 for empty array", () => {
    expect(countImportLabels([])).toBe(0);
  });

  it("counts distinct (chainId, address) pairs in Gnosis Safe format", () => {
    const entries = [
      { address: addr, chainId: "42220", name: "A" },
      { address: addr2, chainId: "42220", name: "B" },
    ];
    expect(countImportLabels(entries)).toBe(2);
  });

  it("deduplicates duplicate (chainId, address) entries", () => {
    const entries = [
      { address: addr, chainId: "42220", name: "A" },
      { address: addr, chainId: "42220", name: "A duplicate" },
    ];
    expect(countImportLabels(entries)).toBe(1);
  });

  it("does not deduplicate same address on different chains", () => {
    const entries = [
      { address: addr, chainId: "42220", name: "Celo" },
      { address: addr, chainId: "1", name: "Mainnet" },
    ];
    expect(countImportLabels(entries)).toBe(2);
  });

  it("deduplicates case-insensitive addresses", () => {
    const entries = [
      { address: addr.toLowerCase(), chainId: "42220", name: "A" },
      { address: addr.toUpperCase(), chainId: "42220", name: "A upper" },
    ];
    expect(countImportLabels(entries)).toBe(1);
  });

  it("deduplicates zero-padded chainId strings ('1' vs '001')", () => {
    // Both parse to chainId 1 via Number(); should count as the same chain.
    const entries = [
      { address: addr, chainId: "1", name: "A" },
      { address: addr, chainId: "001", name: "A again" },
    ];
    expect(countImportLabels(entries)).toBe(1);
  });

  it("counts entries in snapshot format (v2 schema)", () => {
    const snapshot = {
      chains: {
        "42220": { [addr]: { name: "A", tags: [], updatedAt: "" } },
        "1": { [addr2]: { name: "B", tags: [], updatedAt: "" } },
      },
    };
    expect(countImportLabels(snapshot)).toBe(2);
  });

  it("counts entries in snapshot format (legacy v1 schema)", () => {
    const snapshot = {
      chains: {
        "42220": { [addr]: { label: "A", updatedAt: "" } },
      },
    };
    expect(countImportLabels(snapshot)).toBe(1);
  });

  it("deduplicates checksummed vs lowercase addresses in snapshot format", () => {
    // Both map to the same stored key.
    const snapshot = {
      chains: {
        "42220": {
          [addr.toLowerCase()]: { name: "A", tags: [], updatedAt: "" },
          [addr.toUpperCase()]: { name: "A upper", tags: [], updatedAt: "" },
        },
      },
    };
    expect(countImportLabels(snapshot)).toBe(1);
  });

  it("counts entries in simple format (v2 schema)", () => {
    const simple = {
      chainId: 42220,
      labels: {
        [addr]: { name: "A", tags: [], updatedAt: "" },
        [addr2]: { name: "B", tags: [], updatedAt: "" },
      },
    };
    expect(countImportLabels(simple)).toBe(2);
  });

  it("counts entries in simple format (legacy v1 schema)", () => {
    const simple = {
      chainId: 42220,
      labels: {
        [addr]: { label: "A", updatedAt: "" },
      },
    };
    expect(countImportLabels(simple)).toBe(1);
  });

  it("deduplicates checksummed vs lowercase addresses in simple format", () => {
    const simple = {
      chainId: 42220,
      labels: {
        [addr.toLowerCase()]: { name: "A", tags: [], updatedAt: "" },
        [addr.toUpperCase()]: { name: "A upper", tags: [], updatedAt: "" },
      },
    };
    expect(countImportLabels(simple)).toBe(1);
  });

  it("returns 0 for unrecognised payload", () => {
    expect(countImportLabels({ foo: "bar" })).toBe(0);
    expect(countImportLabels(null)).toBe(0);
    expect(countImportLabels(42)).toBe(0);
  });

  it("does not throw when chains is null (snapshot format)", () => {
    expect(countImportLabels({ chains: null })).toBe(0);
  });

  it("does not throw when labels is null (simple format)", () => {
    expect(countImportLabels({ chainId: 42220, labels: null })).toBe(0);
  });

  it("does not throw when a chain entry is null inside snapshot", () => {
    expect(countImportLabels({ chains: { "42220": null } })).toBe(0);
  });

  it("skips malformed entries in array payloads instead of counting them", () => {
    expect(
      countImportLabels([
        null,
        {},
        { chainId: 42220, address: addr },
        { chainId: "42220", address: addr },
      ]),
    ).toBe(1);
  });

  it("does not count array entries with non-string address or chainId", () => {
    expect(
      countImportLabels([
        { chainId: 42220, address: addr, name: "A" },
        { chainId: "42220", address: 123, name: "B" },
      ]),
    ).toBe(0);
  });
});
