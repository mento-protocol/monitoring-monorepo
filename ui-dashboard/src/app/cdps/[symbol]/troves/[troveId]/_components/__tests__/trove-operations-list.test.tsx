/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTroveOperationEventRow } from "../../../../../_lib/types";

vi.mock("@/components/tx-hash-cell", () => ({
  TxHashCell: ({ txHash }: { txHash: string }) => <td>{txHash}</td>,
}));

import { TroveOperationsList } from "../trove-operations-list";

function op(
  overrides: Partial<CdpTroveOperationEventRow> = {},
): CdpTroveOperationEventRow {
  return {
    id: "evt-1",
    troveId: "0x1",
    operation: 2,
    collChange: "0",
    debtChange: "0",
    annualInterestRate: "0",
    debtIncreaseFromUpfrontFee: "0",
    timestamp: "1000",
    blockNumber: "1",
    txHash: "0xabc",
    ...overrides,
  };
}

type Handle = { container: HTMLDivElement; root: Root };

function render(node: React.ReactElement): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

describe("TroveOperationsList", () => {
  let handle: Handle | null = null;

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
      handle = null;
    }
  });

  it("always shows the partial-view notice", () => {
    handle = render(
      <TroveOperationsList
        rows={[]}
        truncated={false}
        isLoading={false}
        error={undefined}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(handle.container.textContent).toContain(
      "Per-redemption detail pending indexer rollout",
    );
  });

  it("shows an empty state with no rows", () => {
    handle = render(
      <TroveOperationsList
        rows={[]}
        truncated={false}
        isLoading={false}
        error={undefined}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(handle.container.textContent).toContain(
      "No operations indexed for this trove yet.",
    );
  });

  it("renders a badge, signed deltas, and the tx per row", () => {
    handle = render(
      <TroveOperationsList
        rows={[
          op({
            id: "evt-open",
            operation: 0,
            debtChange: "1000000000000000000",
            collChange: "-500000000000000000",
          }),
        ]}
        truncated={false}
        isLoading={false}
        error={undefined}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).toContain("Open Trove");
    expect(text).toContain("1.00 GBPm");
    expect(text).toContain("-0.50 USDm");
    expect(text).toContain("0xabc");
  });

  it("discloses truncation only when the sentinel row was present (caller-supplied flag)", () => {
    handle = render(
      <TroveOperationsList
        rows={[op()]}
        truncated={true}
        isLoading={false}
        error={undefined}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(handle.container.textContent).toContain(
      "Earliest history truncated",
    );

    act(() => handle!.root.unmount());
    handle.container.remove();

    handle = render(
      <TroveOperationsList
        rows={[op()]}
        truncated={false}
        isLoading={false}
        error={undefined}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(handle.container.textContent).not.toContain(
      "Earliest history truncated",
    );
  });

  it("shows an error only when there is no fallback data to display", () => {
    handle = render(
      <TroveOperationsList
        rows={[]}
        truncated={false}
        isLoading={false}
        error={new Error("boom")}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(
      handle.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("boom");

    act(() => handle!.root.unmount());
    handle.container.remove();

    handle = render(
      <TroveOperationsList
        rows={[op()]}
        truncated={false}
        isLoading={false}
        error={new Error("boom")}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(handle.container.querySelector('[role="alert"]')).toBeNull();
    expect(handle.container.textContent).toContain("0xabc");
  });
});
