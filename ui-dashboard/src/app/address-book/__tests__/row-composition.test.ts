/**
 * Tests for address book row composition using the shared helpers from
 * @/lib/address-book — same functions used in page.tsx.
 *
 * Key invariants:
 * - Custom rows are address-keyed; one row per address.
 * - A custom row suppresses every contract row for the same address (across all chains).
 * - Contract rows are still per-chain (each network's static addressLabels registry).
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

function customRow(address: string, displayNet: Network): AddressBookRow {
  return {
    key: `custom:${address.toLowerCase()}`,
    address,
    name: "Custom label",
    tags: [],
    isCustom: true,
    network: displayNet,
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

  it("keeps same address from different chains as separate rows when no custom label", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO), contractRow(ADDR_A, NET_MONAD)],
      [],
    );
    expect(rows).toHaveLength(2);
  });

  it("a custom row suppresses every contract row for the same address (all chains)", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO), contractRow(ADDR_A, NET_MONAD)],
      [customRow(ADDR_A, NET_CELO)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("custom row for one address does NOT suppress contract rows for unrelated addresses", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_CELO), contractRow(ADDR_B, NET_MONAD)],
      [customRow(ADDR_A, NET_CELO)],
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => !r.isCustom && r.address === ADDR_B)).toBe(true);
  });

  it("same-chainId different-networkId: custom suppresses both contract rows for that address", () => {
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

  it("counts distinct addresses in Gnosis Safe format (chainId is ignored)", () => {
    const entries = [
      { address: addr, chainId: "42220", name: "A" },
      { address: addr2, chainId: "42220", name: "B" },
    ];
    expect(countImportLabels(entries)).toBe(2);
  });

  it("deduplicates duplicate address entries", () => {
    const entries = [
      { address: addr, chainId: "42220", name: "A" },
      { address: addr, chainId: "42220", name: "A duplicate" },
    ];
    expect(countImportLabels(entries)).toBe(1);
  });

  it("deduplicates same address across different chainIds (labels are now address-keyed)", () => {
    const entries = [
      { address: addr, chainId: "42220", name: "Celo" },
      { address: addr, chainId: "1", name: "Mainnet" },
    ];
    expect(countImportLabels(entries)).toBe(1);
  });

  it("deduplicates case-insensitive addresses", () => {
    const entries = [
      { address: addr.toLowerCase(), chainId: "42220", name: "A" },
      { address: addr.toUpperCase(), chainId: "42220", name: "A upper" },
    ];
    expect(countImportLabels(entries)).toBe(1);
  });

  it("counts entries in legacy snapshot format (chains)", () => {
    const snapshot = {
      chains: {
        "42220": { [addr]: { name: "A", tags: [], updatedAt: "" } },
        "1": { [addr2]: { name: "B", tags: [], updatedAt: "" } },
      },
    };
    expect(countImportLabels(snapshot)).toBe(2);
  });

  it("counts legacy global + chain entries together (no double-counting)", () => {
    const snapshot = {
      global: { [addr]: { name: "Global", tags: [], updatedAt: "" } },
      chains: {
        "42220": { [addr2]: { name: "Celo", tags: [], updatedAt: "" } },
      },
    };
    expect(countImportLabels(snapshot)).toBe(2);
  });

  it("legacy global and chain entries for same address dedupe to one address-key", () => {
    const snapshot = {
      global: { [addr]: { name: "Global", tags: [], updatedAt: "" } },
      chains: {
        "42220": { [addr]: { name: "Celo", tags: [], updatedAt: "" } },
      },
    };
    expect(countImportLabels(snapshot)).toBe(1);
  });

  it("counts entries in new flat snapshot shape (addresses)", () => {
    const snapshot = {
      addresses: {
        [addr]: { name: "A", tags: [], updatedAt: "" },
        [addr2]: { name: "B", tags: [], updatedAt: "" },
      },
    };
    expect(countImportLabels(snapshot)).toBe(2);
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

  it("counts entries in simple format (chainId column ignored)", () => {
    const simple = {
      chainId: 42220,
      labels: {
        [addr]: { name: "A", tags: [], updatedAt: "" },
        [addr2]: { name: "B", tags: [], updatedAt: "" },
      },
    };
    expect(countImportLabels(simple)).toBe(2);
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

  it("does not count array entries with non-string address", () => {
    expect(
      countImportLabels([
        { chainId: 42220, address: addr, name: "A" },
        { chainId: "42220", address: 123, name: "B" },
      ]),
    ).toBe(1);
  });
});
