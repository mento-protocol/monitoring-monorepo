/**
 * Tests for address book row composition using the shared helpers from
 * @/lib/address-book — same functions used in page.tsx.
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

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeNet(id: string): Network {
  return {
    id: id as Network["id"],
    label: `Net ${id}`,
    chainId: 1,
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

const NET_MAIN = makeNet("celo-mainnet-hosted");
const NET_MONAD = makeNet("monad-mainnet-hosted");

function contractRow(
  address: string,
  net: Network,
  label = "Contract",
): AddressBookRow {
  return {
    key: `${net.id}:${address}`,
    address,
    label,
    isCustom: false,
    network: net,
  };
}

function customRow(address: string, net: Network): AddressBookRow {
  return {
    key: `custom:${address}`,
    address,
    label: "Custom label",
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
      [contractRow(ADDR_A, NET_MAIN), contractRow(ADDR_B, NET_MONAD)],
      [],
      NET_MAIN.id,
    );
    expect(rows).toHaveLength(2);
  });

  it("keeps same address from different chains as separate rows", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_MAIN), contractRow(ADDR_A, NET_MONAD)],
      [],
      NET_MAIN.id,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.network?.id).sort()).toEqual(
      [NET_MAIN.id, NET_MONAD.id].sort(),
    );
  });

  it("hides contract row on selected network when custom label exists", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_MAIN)],
      [customRow(ADDR_A, NET_MAIN)],
      NET_MAIN.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCustom).toBe(true);
  });

  it("does NOT hide contract row from other network when custom exists on selected", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_A, NET_MAIN), contractRow(ADDR_A, NET_MONAD)],
      [customRow(ADDR_A, NET_MAIN)],
      NET_MAIN.id,
    );
    // Custom + Monad contract row (Celo contract row replaced by custom)
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.network?.id === NET_MONAD.id)).toBe(true);
  });

  it("custom rows come first in the result", () => {
    const rows = buildAddressBookRows(
      [contractRow(ADDR_B, NET_MAIN)],
      [customRow(ADDR_A, NET_MAIN)],
      NET_MAIN.id,
    );
    expect(rows[0].isCustom).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveIsCustom
// ---------------------------------------------------------------------------

describe("resolveIsCustom", () => {
  it("contract row on selected network is NOT marked custom by default", () => {
    const row = contractRow(ADDR_B, NET_MAIN);
    expect(resolveIsCustom(row, NET_MAIN.id, () => false)).toBe(false);
  });

  it("contract row on selected network IS marked custom when isCustomLabel returns true", () => {
    const row = contractRow(ADDR_A, NET_MAIN);
    expect(resolveIsCustom(row, NET_MAIN.id, () => true)).toBe(true);
  });

  it("contract row on OTHER network is NOT marked custom even if address has custom on selected", () => {
    const row = contractRow(ADDR_A, NET_MONAD);
    // isCustomLabel would return true (selected network has a custom label for this address)
    expect(resolveIsCustom(row, NET_MAIN.id, () => true)).toBe(false);
  });

  it("custom row is always marked custom", () => {
    const row = customRow(ADDR_A, NET_MAIN);
    expect(resolveIsCustom(row, NET_MAIN.id, () => false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveCanEdit
// ---------------------------------------------------------------------------

describe("resolveCanEdit", () => {
  it("allows editing rows on the selected network", () => {
    expect(resolveCanEdit(contractRow(ADDR_A, NET_MAIN), NET_MAIN.id)).toBe(
      true,
    );
  });

  it("disables editing for contract rows on other networks", () => {
    expect(resolveCanEdit(contractRow(ADDR_A, NET_MONAD), NET_MAIN.id)).toBe(
      false,
    );
  });

  it("allows editing custom rows (network=null)", () => {
    const row: AddressBookRow = {
      key: "custom",
      address: ADDR_A,
      label: "lbl",
      isCustom: true,
      network: null,
    };
    expect(resolveCanEdit(row, NET_MAIN.id)).toBe(true);
  });
});
