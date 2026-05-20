/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CdpTxAmountCell } from "../cdp-tx-amount-cell";
import type { TroveSnapshot } from "../../_lib/transactions";
import type { CdpTransactionRow } from "../../_lib/types";

const troveOpRow: CdpTransactionRow = {
  kind: "troveOp",
  id: "evt-1",
  instanceId: "inst-1",
  troveId: "trove-1",
  operation: 2,
  collChange: "0",
  debtChange: "0",
  annualInterestRate: "0",
  debtIncreaseFromUpfrontFee: "0",
  timestamp: "1000",
  blockNumber: "1",
  txHash: "0xabc",
};

const redemptionRow: CdpTransactionRow = {
  kind: "redemption",
  id: "red-1",
  instanceId: "inst-1",
  attemptedBoldAmount: "1000000000000000000000",
  actualBoldAmount: "950000000000000000000",
  ETHSent: "500000000000000000",
  ETHFee: "0",
  price: "0",
  redemptionPrice: "0",
  isRebalance: false,
  timestamp: "1000",
  blockNumber: "1",
  txHash: "0xdef",
};

function renderInTable(node: React.ReactElement): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <table>
        <tbody>
          <tr>{node}</tr>
        </tbody>
      </table>,
    );
  });
  return { container, root };
}

describe("CdpTxAmountCell", () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = null;
    }
  });

  it("falls back to flat amount when snapshot is null (non-trove-op row)", () => {
    mounted = renderInTable(
      <CdpTxAmountCell
        row={redemptionRow}
        symbol="cGBP"
        leg="debt"
        snapshot={null}
      />,
    );
    // Flat amount path renders a single text node — no `→` arrow.
    expect(mounted.container.textContent).not.toContain("→");
    expect(mounted.container.textContent).toContain("cGBP");
  });

  it("falls back to flat amount when snapshot is null (deploy+resync window)", () => {
    mounted = renderInTable(
      <CdpTxAmountCell
        row={troveOpRow}
        symbol="cGBP"
        leg="debt"
        snapshot={null}
      />,
    );
    expect(mounted.container.textContent).not.toContain("→");
  });

  it("renders before → after with no delta line when delta is zero", () => {
    const snap: TroveSnapshot = {
      debt: {
        before: "1000000000000000000000",
        after: "1000000000000000000000",
        delta: "0",
      },
      coll: {
        before: "500000000000000000000",
        after: "500000000000000000000",
        delta: "0",
      },
    };
    mounted = renderInTable(
      <CdpTxAmountCell
        row={troveOpRow}
        symbol="cGBP"
        leg="debt"
        snapshot={snap}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("→");
    // Zero delta should suppress the delta footer so the row stays tight.
    expect(text).not.toContain("(+");
    expect(text).not.toContain("(−");
  });

  it("renders the delta with leading '+' and emerald color when before < after (borrow / deposit)", () => {
    const snap: TroveSnapshot = {
      debt: {
        before: "1000000000000000000000",
        after: "2500000000000000000000",
        delta: "1500000000000000000000",
      },
      coll: {
        before: "500000000000000000000",
        after: "500000000000000000000",
        delta: "0",
      },
    };
    mounted = renderInTable(
      <CdpTxAmountCell
        row={troveOpRow}
        symbol="cGBP"
        leg="debt"
        snapshot={snap}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("(+");
    const deltaSpan = mounted.container.querySelector(".text-emerald-400");
    expect(deltaSpan).not.toBeNull();
  });

  it("renders the delta with leading '−' and rose color when before > after (repay / withdraw)", () => {
    const snap: TroveSnapshot = {
      debt: {
        before: "5000000000000000000000",
        after: "4000000000000000000000",
        delta: "-1000000000000000000000",
      },
      coll: {
        before: "500000000000000000000",
        after: "500000000000000000000",
        delta: "0",
      },
    };
    mounted = renderInTable(
      <CdpTxAmountCell
        row={troveOpRow}
        symbol="cGBP"
        leg="debt"
        snapshot={snap}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("(−");
    const deltaSpan = mounted.container.querySelector(".text-rose-400");
    expect(deltaSpan).not.toBeNull();
  });
});
