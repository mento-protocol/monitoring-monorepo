/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpTroveLedgerEventRow } from "../../_lib/ledger";

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => <td>{txHash}</td>,
}));

import { TroveLedgerTable } from "../trove-ledger-table";

const NOW = 1_767_225_600;
const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function ledgerRow(
  overrides: Partial<CdpTroveLedgerEventRow> = {},
): CdpTroveLedgerEventRow {
  return {
    id: "42220_100_1",
    operation: 2,
    collChange: "0",
    debtChange: "0",
    debtIncreaseFromUpfrontFee: "0",
    debtIncreaseFromRedist: "0",
    collIncreaseFromRedist: "0",
    annualInterestRate: "0",
    debtBefore: wei(1_000),
    debtAfter: wei(1_000),
    collBefore: wei(500),
    collAfter: wei(500),
    statusBefore: "active",
    statusAfter: "active",
    redemptionFeeCredited: null,
    isRebalance: null,
    redemptionPrice: null,
    priceAtEvent: null,
    icrAfterBps: null,
    timestamp: String(NOW - 1000),
    blockNumber: "100",
    logIndex: 1,
    txHash: "0xtx1",
    ...overrides,
  };
}

const BASE_PROPS = {
  truncated: false,
  complete: true,
  anchored: true,
  debtSnapshotsComplete: true,
  isLoading: false,
  error: undefined,
  hasLoadedOnce: true,
  chainId: 42220,
  debtSymbol: "GBPm",
  mcrBps: 11_000,
};

type Handle = { container: HTMLElement; root: Root };

let handle: Handle | null = null;

function render(props: Partial<React.ComponentProps<typeof TroveLedgerTable>>) {
  act(() => {
    handle!.root.render(
      <TroveLedgerTable rows={[]} {...BASE_PROPS} {...props} />,
    );
  });
}

function text(): string {
  return handle!.container.textContent ?? "";
}

function rowTexts(): string[] {
  return Array.from(handle!.container.querySelectorAll("table tbody tr")).map(
    (row) => row.textContent ?? "",
  );
}

describe("TroveLedgerTable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const container = document.createElement("div");
    document.body.appendChild(container);
    handle = { container, root: createRoot(container) };
  });

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
    }
    handle = null;
    vi.useRealTimers();
  });

  it("renders all ten operation ordinals with truthful labels", () => {
    const ops: Array<[number, string]> = [
      [0, "Open Trove"],
      [1, "Close Trove"],
      [2, "Adjust Trove"],
      [3, "Change Interest Rate"],
      [4, "Apply Pending Debt"],
      [5, "Liquidation"],
      [6, "Redemption"],
      [7, "Open & Join Batch"],
      [8, "Joined Batch"],
      [9, "Left Batch"],
    ];
    render({
      // complete: false keeps synthetic rows out so tbody rows map 1:1.
      complete: false,
      rows: ops.map(([operation], i) =>
        ledgerRow({
          id: `42220_${100 + i}_1`,
          operation,
          blockNumber: String(100 + i),
          timestamp: String(NOW - 10_000 + i),
        }),
      ),
    });

    const rows = rowTexts();
    expect(rows).toHaveLength(10);
    for (const [i, [, label]] of ops.entries()) {
      expect(rows[i]).toContain(label);
    }
  });

  it("discriminates rebalance vs user redemptions via isRebalance", () => {
    render({
      complete: false,
      rows: [
        ledgerRow({ id: "42220_100_1", operation: 6, isRebalance: true }),
        ledgerRow({
          id: "42220_101_1",
          operation: 6,
          isRebalance: false,
          blockNumber: "101",
        }),
      ],
    });
    const rows = rowTexts();
    expect(rows[0]).toContain("Rebalance Redemption");
    expect(rows[1]).toContain("Redemption");
    expect(rows[1]).not.toContain("Rebalance");
  });

  it("chooses formatters per field semantics: signed deltas, unsigned totals, and a real −1 wei delta", () => {
    render({
      complete: false,
      rows: [
        ledgerRow({
          debtChange: "-1", // a legitimate −1 wei repayment, NOT the unknown sentinel
          debtBefore: wei(1_000),
          debtAfter: (BigInt(wei(1_000)) - BigInt(1)).toString(),
          collChange: `-${wei(200)}`,
          collAfter: wei(300),
        }),
      ],
    });
    const row = rowTexts()[0]!;
    // Signed formatter renders the −1 wei delta as a (tiny) negative value,
    // never the em dash unknown sentinel.
    expect(row).toContain("-0.00 GBPm");
    expect(row).toContain("-200.00 USDm");
    // Unsigned totals for the resulting balances.
    expect(row).toContain("300.00 USDm");
  });

  it("renders null debtAfter/icrAfterBps as an em dash, never zero, plus the batch notice", () => {
    render({
      debtSnapshotsComplete: false,
      rows: [
        ledgerRow({
          operation: 8,
          debtBefore: null,
          debtAfter: null,
          icrAfterBps: null,
        }),
      ],
    });
    const row = rowTexts()[0]!;
    expect(row).toContain("—");
    expect(row).not.toContain("0.00 GBPm");
    expect(text()).toContain("Batch data unavailable");
  });

  it("renders ICR→ from icrAfterBps when derivable", () => {
    render({
      complete: false,
      rows: [ledgerRow({ icrAfterBps: 11_710 })],
    });
    expect(rowTexts()[0]).toContain("117.10%");
  });

  it("renders the upfront fee and the credited redemption fee as positive amounts", () => {
    render({
      complete: false,
      rows: [
        ledgerRow({
          id: "42220_100_1",
          operation: 0,
          debtChange: wei(25_000),
          debtIncreaseFromUpfrontFee: wei(12),
          debtBefore: "0",
          debtAfter: wei(25_012),
        }),
        ledgerRow({
          id: "42220_101_1",
          operation: 6,
          isRebalance: true,
          redemptionFeeCredited: wei(2),
          blockNumber: "101",
        }),
      ],
    });
    const rows = rowTexts();
    // Δ debt INCLUDES the fee (before + Δ = after exactly); the Fees column
    // breaks the fee component out.
    expect(rows[0]).toContain("25,012.00 GBPm");
    expect(rows[0]).toContain("+12.00 GBPm fee");
    expect(rows[1]).toContain("+2.00 USDm credited");
  });

  it("annotates status flips: zombie pill, revived pill, plain text otherwise, none on opens", () => {
    render({
      complete: false,
      rows: [
        ledgerRow({
          id: "42220_100_1",
          operation: 6,
          statusBefore: "active",
          statusAfter: "zombie",
        }),
        ledgerRow({
          id: "42220_101_1",
          operation: 2,
          statusBefore: "zombie",
          statusAfter: "active",
          blockNumber: "101",
        }),
        ledgerRow({
          id: "42220_102_1",
          operation: 0,
          statusBefore: "closed",
          statusAfter: "active",
          blockNumber: "102",
        }),
      ],
    });
    const rows = rowTexts();
    expect(rows[0]).toContain("active → zombie");
    expect(rows[1]).toContain("zombie → active");
    // The pre-open placeholder flip is suppressed on the open row.
    expect(rows[2]).not.toContain("closed → active");
  });

  it("synthesizes labeled interest-estimate rows only in complete mode", () => {
    const rows = [
      ledgerRow({
        id: "42220_100_1",
        operation: 0,
        debtChange: wei(1_000),
        debtBefore: "0",
        debtAfter: wei(1_000),
        timestamp: String(NOW - 90_000),
      }),
      ledgerRow({
        id: "42220_200_1",
        operation: 2,
        debtBefore: wei(1_010),
        debtAfter: wei(1_010),
        blockNumber: "200",
        timestamp: String(NOW - 1_000),
      }),
    ];
    render({ rows, complete: true });
    expect(text()).toContain("Interest accrued");
    expect(text()).toContain("estimate");
    expect(text()).toContain("≈ +10.00 GBPm");
    expect(text()).toContain("excluded from every total");
    expect(rowTexts()).toHaveLength(3);

    // A truncated (or otherwise partial) ledger suppresses the estimates.
    render({ rows, complete: false, truncated: true });
    expect(text()).not.toContain("Interest accrued");
    expect(rowTexts()).toHaveLength(2);

    // An un-anchored response (watermark ≠ newest row — possibly a
    // mid-write read whose snapshots aren't finalized) suppresses them too,
    // even for a complete, snapshot-complete page (#2088 requirement: the
    // residual gates on the same complete-rows + watermark conditions).
    render({ rows, complete: true, anchored: false });
    expect(text()).not.toContain("Interest accrued");
    expect(rowTexts()).toHaveLength(2);
  });

  it("qualifies the complete-history claim with a mid-update notice while un-anchored", () => {
    render({ rows: [ledgerRow()], anchored: false });
    expect(text()).toContain("Snapshot mid-update");

    // Anchored again: the notice clears.
    render({ rows: [ledgerRow()], anchored: true });
    expect(text()).not.toContain("Snapshot mid-update");
  });

  it("defaults to chronological ascending; the header toggle reverses and exposes aria-sort", () => {
    render({
      complete: false,
      rows: [
        ledgerRow({ id: "42220_100_1", txHash: "0xoldest" }),
        ledgerRow({
          id: "42220_200_1",
          blockNumber: "200",
          timestamp: String(NOW - 10),
          txHash: "0xnewest",
        }),
      ],
    });

    const header = handle!.container.querySelector("th[aria-sort]");
    expect(header?.getAttribute("aria-sort")).toBe("ascending");
    let rows = rowTexts();
    expect(rows[0]).toContain("0xoldest");
    expect(rows[1]).toContain("0xnewest");

    const toggle = header?.querySelector("button");
    expect(toggle?.getAttribute("type")).toBe("button");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      handle!.container
        .querySelector("th[aria-sort]")
        ?.getAttribute("aria-sort"),
    ).toBe("descending");
    rows = rowTexts();
    expect(rows[0]).toContain("0xnewest");
    expect(rows[1]).toContain("0xoldest");
  });

  it("discloses truncation only when flagged", () => {
    render({ rows: [ledgerRow()], truncated: true, complete: false });
    expect(text()).toContain("Earliest history truncated");

    render({ rows: [ledgerRow()], truncated: false });
    expect(text()).not.toContain("Earliest history truncated");
  });

  it("keeps loading, confirmed-empty, and error states distinct", () => {
    render({ rows: [], isLoading: true, hasLoadedOnce: false });
    expect(
      handle!.container.querySelector('[aria-label="Loading table"]'),
    ).not.toBeNull();

    render({ rows: [], isLoading: false, hasLoadedOnce: true });
    expect(text()).toContain("No ledger events indexed for this trove yet.");

    render({
      rows: [],
      error: new Error("ledger down"),
      hasLoadedOnce: false,
    });
    const alert = handle!.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Failed to load the trove ledger");
    expect(alert?.textContent).toContain("ledger down");
  });

  it("discloses a refresh failure over confirmed rows as stale, not a hard error", () => {
    render({
      rows: [ledgerRow()],
      complete: true,
      error: new Error("revalidation stalled"),
      hasLoadedOnce: true,
    });
    expect(text()).toContain("Trove ledger refresh failed");
    expect(text()).toContain("showing the last confirmed state");
    // The confirmed rows keep rendering below the notice, and the hard
    // first-load ErrorBox never appears (the stale notice IS an alert).
    expect(handle!.container.querySelector("table")).not.toBeNull();
    expect(text()).not.toContain("Failed to load the trove ledger");
  });
});
