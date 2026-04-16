/**
 * Tests for address book row composition using the shared helpers from
 * @/lib/address-book — same functions used in page.tsx.
 *
 * Key invariants:
 * - Every row is chain-scoped (row.network is always present now).
 * - Deduplication uses (chainId, lowercaseAddress); custom wins over contract.
 */

import { describe, it, expect } from "vitest";
import {
  buildAddressBookRows,
  countImportLabels,
  type AddressBookRow,
} from "@/lib/address-book";
import type { Network } from "@/lib/networks";

const ADDR_A = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"; // mixed-case
const ADDR_A_LC = "0xabcdef1234567890abcdef1234567890abcdef12";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const NET_CELO = makeNet("celo-mainnet", 42220);
const NET_CELO_LOCAL = makeNet("celo-mainnet-local", 42220);
const NET_MONAD = makeNet("monad-mainnet", 143);

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
    key: `custom:${net.chainId}:${address.toLowerCase()}`,
    address,
    name: "Custom label",
    tags: [],
    isCustom: true,
    network: net,
  };
}

describe("buildAddressBookRows", () => {
  it("returns all contract rows when no custom labels exist", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO), contractRow(ADDR_B, NET_MONAD)],
      [],
    );
    expect(rows).toHaveLength(2);
  });

  it("keeps same address from different chains as separate rows", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO), contractRow(ADDR_A, NET_MONAD)],
      [],
    );
    expect(rows).toHaveLength(2);
  });

  it("hides contract row on the same chain when a custom label exists", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO)],
      [customRow(ADDR_A, NET_CELO)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("does NOT hide contract row on a different chain when custom is on another", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO), contractRow(ADDR_A, NET_MONAD)],
      [customRow(ADDR_A, NET_CELO)],
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.network.chainId === NET_MONAD.chainId)).toBe(
      true,
    );
  });

  it("same-chainId different-networkId: custom suppresses both contract rows on that chain", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO), contractRow(ADDR_A, NET_CELO_LOCAL)],
      [customRow(ADDR_A, NET_CELO)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("matches addresses case-insensitively", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO)],
      [customRow(ADDR_A_LC, NET_CELO)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("custom rows come first in the result", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_B, NET_CELO)],
      [customRow(ADDR_A, NET_CELO)],
    );
    expect(rows[0].isCustom).toBe(true);
  });
});

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
