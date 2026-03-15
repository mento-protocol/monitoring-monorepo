/**
 * Tests for address book cross-network row composition rules.
 *
 * The merge logic in page.tsx follows these rules:
 * 1. Contract rows: one per (networkId, address) — same address on different
 *    chains is two separate rows.
 * 2. Custom rows: come from the selected network only (chain-scoped storage).
 * 3. Dedupe: custom row on selectedNetwork hides the contract row for the
 *    same address on that network, but NOT contract rows for the same address
 *    on other networks.
 * 4. isCustom: only true when the row is actually a custom label OR when
 *    it belongs to the selected network and isCustomLabel() returns true.
 * 5. canEdit: only true when row is on the selected network (or custom).
 *    Non-selected-chain contract rows show "—" to avoid writing to wrong chain.
 */

import { describe, it, expect } from "vitest";
import type { Network } from "@/lib/networks";

// ---------------------------------------------------------------------------
// Pure helpers extracted from page.tsx logic for isolated testing
// ---------------------------------------------------------------------------

type TableRow = {
  key: string;
  address: string;
  label: string;
  isCustom: boolean;
  network: Network | null;
};

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

/** Mirrors the allRows merge logic from page.tsx */
function buildAllRows(
  contractRows: TableRow[],
  customRows: TableRow[],
  selectedNetworkId: string,
): TableRow[] {
  const customKeysOnSelectedNet = new Set(
    customRows.map((r) => `${selectedNetworkId}:${r.address}`),
  );
  const filteredContractRows = contractRows.filter(
    (r) => !customKeysOnSelectedNet.has(`${r.network?.id ?? ""}:${r.address}`),
  );
  return [...customRows, ...filteredContractRows];
}

/** Mirrors isCustomResolved logic */
function resolveIsCustom(
  row: TableRow,
  selectedNetworkId: string,
  customAddresses: Set<string>,
): boolean {
  const isOnSelectedNetwork =
    row.network === null || row.network.id === selectedNetworkId;
  return (
    row.isCustom || (isOnSelectedNetwork && customAddresses.has(row.address))
  );
}

/** Mirrors canEdit logic */
function resolveCanEdit(row: TableRow, selectedNetworkId: string): boolean {
  return row.network === null || row.network.id === selectedNetworkId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("address book row composition", () => {
  describe("contract row deduplication", () => {
    it("keeps same address from different chains as separate rows", () => {
      const contractRows: TableRow[] = [
        {
          key: "celo-mainnet-hosted:0xaaa",
          address: ADDR_A,
          label: "Token A (Celo)",
          isCustom: false,
          network: NET_MAIN,
        },
        {
          key: "monad-mainnet-hosted:0xaaa",
          address: ADDR_A,
          label: "Token A (Monad)",
          isCustom: false,
          network: NET_MONAD,
        },
      ];
      const result = buildAllRows(contractRows, [], NET_MAIN.id);
      expect(result).toHaveLength(2);
    });

    it("hides contract row on selected network when custom label exists", () => {
      const contractRows: TableRow[] = [
        {
          key: "celo-mainnet-hosted:0xaaa",
          address: ADDR_A,
          label: "Contract label",
          isCustom: false,
          network: NET_MAIN,
        },
      ];
      const customRows: TableRow[] = [
        {
          key: "custom:0xaaa",
          address: ADDR_A,
          label: "My custom label",
          isCustom: true,
          network: NET_MAIN,
        },
      ];
      const result = buildAllRows(contractRows, customRows, NET_MAIN.id);
      expect(result).toHaveLength(1);
      expect(result[0].isCustom).toBe(true);
      expect(result[0].label).toBe("My custom label");
    });

    it("does NOT hide contract row from other network when custom label exists on selected", () => {
      const contractRows: TableRow[] = [
        {
          key: "celo-mainnet-hosted:0xaaa",
          address: ADDR_A,
          label: "Token (Celo)",
          isCustom: false,
          network: NET_MAIN,
        },
        {
          key: "monad-mainnet-hosted:0xaaa",
          address: ADDR_A,
          label: "Token (Monad)",
          isCustom: false,
          network: NET_MONAD,
        },
      ];
      const customRows: TableRow[] = [
        {
          key: "custom:0xaaa",
          address: ADDR_A,
          label: "My custom",
          isCustom: true,
          network: NET_MAIN,
        },
      ];
      const result = buildAllRows(contractRows, customRows, NET_MAIN.id);
      // Custom + Monad contract row; Celo contract row hidden
      expect(result).toHaveLength(2);
      const monadRow = result.find((r) => r.network?.id === NET_MONAD.id);
      expect(monadRow).toBeDefined();
      expect(monadRow?.label).toBe("Token (Monad)");
    });
  });

  describe("isCustom resolution", () => {
    it("contract row on selected network is NOT marked custom", () => {
      const row: TableRow = {
        key: "k",
        address: ADDR_B,
        label: "lbl",
        isCustom: false,
        network: NET_MAIN,
      };
      const customAddresses = new Set<string>();
      expect(resolveIsCustom(row, NET_MAIN.id, customAddresses)).toBe(false);
    });

    it("contract row on OTHER network is NOT marked custom even if address has custom on selected", () => {
      const row: TableRow = {
        key: "k",
        address: ADDR_A,
        label: "lbl",
        isCustom: false,
        network: NET_MONAD,
      };
      // ADDR_A has a custom label on selected (Celo)
      const customAddresses = new Set([ADDR_A]);
      expect(resolveIsCustom(row, NET_MAIN.id, customAddresses)).toBe(false);
    });

    it("custom row is always marked custom regardless of network", () => {
      const row: TableRow = {
        key: "k",
        address: ADDR_A,
        label: "lbl",
        isCustom: true,
        network: NET_MAIN,
      };
      expect(resolveIsCustom(row, NET_MAIN.id, new Set())).toBe(true);
    });
  });

  describe("canEdit resolution", () => {
    it("allows editing rows on the selected network", () => {
      const row: TableRow = {
        key: "k",
        address: ADDR_A,
        label: "lbl",
        isCustom: false,
        network: NET_MAIN,
      };
      expect(resolveCanEdit(row, NET_MAIN.id)).toBe(true);
    });

    it("disables editing for contract rows on other networks", () => {
      const row: TableRow = {
        key: "k",
        address: ADDR_A,
        label: "lbl",
        isCustom: false,
        network: NET_MONAD,
      };
      expect(resolveCanEdit(row, NET_MAIN.id)).toBe(false);
    });

    it("allows editing custom rows (network=null)", () => {
      const row: TableRow = {
        key: "k",
        address: ADDR_A,
        label: "lbl",
        isCustom: true,
        network: null,
      };
      expect(resolveCanEdit(row, NET_MAIN.id)).toBe(true);
    });
  });
});
