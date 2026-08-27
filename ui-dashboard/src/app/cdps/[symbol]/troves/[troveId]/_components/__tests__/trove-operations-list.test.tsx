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

const D18 = BigInt(10) ** BigInt(18);

function rateWei(bps: number): string {
  return ((BigInt(bps) * D18) / BigInt(10_000)).toString();
}

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

  it("shows the new rate for a rate-only interest-rate-change operation (debt/coll deltas are both zero)", () => {
    handle = render(
      <TroveOperationsList
        rows={[
          op({
            id: "evt-rate",
            operation: 3, // adjustInterestRate
            debtChange: "0",
            collChange: "0",
            annualInterestRate: rateWei(250),
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
    expect(text).toContain("Change Interest Rate");
    expect(text).toContain("2.50%");
  });

  it("shows the new rate for a batch-membership operation", () => {
    handle = render(
      <TroveOperationsList
        rows={[
          op({
            id: "evt-batch",
            operation: 8, // setBatchManager
            debtChange: "0",
            collChange: "0",
            annualInterestRate: rateWei(175),
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
    expect(text).toContain("Batch Membership");
    expect(text).toContain("1.75%");
  });

  it("does not show a rate annotation for a regular adjust/open/close operation", () => {
    handle = render(
      <TroveOperationsList
        rows={[
          op({
            id: "evt-adjust",
            operation: 2,
            annualInterestRate: rateWei(999),
          }),
        ]}
        truncated={false}
        isLoading={false}
        error={undefined}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(handle.container.textContent).not.toContain("9.99%");
  });

  it("makes the row's exact timestamp reachable without a mouse, via a focusable tooltip", () => {
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
    const trigger = handle.container.querySelector(
      "td button[aria-describedby]",
    );
    expect(trigger).not.toBeNull();
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

  it("shows a hard error (no table) only when there is no fallback data to display", () => {
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
    expect(handle.container.querySelector("table")).toBeNull();
  });

  it("discloses a failed refresh while keeping the cached rows on screen, instead of silently continuing", () => {
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
    const text = handle.container.textContent ?? "";
    // The table still renders from the cached rows...
    expect(text).toContain("0xabc");
    expect(handle.container.querySelector("table")).not.toBeNull();
    // ...but discloses that the poll behind it failed, via the same
    // StaleRefreshNotice wording the parent view uses for its other
    // queries (markets/trove/batch rate).
    expect(text).toContain("Trove operations refresh failed");
    expect(text).toContain("showing the last confirmed state");
    expect(text).toContain("boom");
  });

  it("shows no stale-refresh notice when there is no error", () => {
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
    expect(handle.container.textContent).not.toContain("refresh failed");
    expect(handle.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves a confirmed-empty result (not the hard error) when a poll fails after a real prior load", () => {
    // rows.length === 0 alone can't distinguish "never loaded" from
    // "loaded, confirmed empty" — a trove with zero real operations is a
    // legitimate empty state. `hasLoadedOnce` disambiguates it: the failed
    // refresh still gets an alert (via the shared StaleRefreshNotice), but
    // it's the "showing the last confirmed state" wording, not the harder
    // "Failed to load" first-load message, and the empty-state box (not a
    // blank content area) still renders underneath it.
    handle = render(
      <TroveOperationsList
        rows={[]}
        truncated={false}
        isLoading={false}
        error={new Error("boom")}
        hasLoadedOnce
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    const text = handle.container.textContent ?? "";
    expect(text).not.toContain("Failed to load trove operations");
    expect(text).toContain("No operations indexed for this trove yet.");
    expect(text).toContain("Trove operations refresh failed");
    expect(text).toContain("showing the last confirmed state");
    expect(text).toContain("boom");
  });

  it("shows the hard error for a genuine first-load failure (hasLoadedOnce omitted, defaults from empty rows)", () => {
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
  });

  it("uses a table-shaped skeleton (not generic bars) while operations are loading", () => {
    handle = render(
      <TroveOperationsList
        rows={[]}
        truncated={false}
        isLoading={true}
        error={undefined}
        chainId={42220}
        debtSymbol="GBPm"
      />,
    );
    expect(
      handle.container.querySelector('[aria-label="Loading table"]'),
    ).not.toBeNull();
  });

  it("announces the truncation disclosure as a live status region", () => {
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
    const notice = Array.from(
      handle.container.querySelectorAll('[role="status"]'),
    ).find((el) => el.textContent?.includes("Earliest history truncated"));
    expect(notice).toBeDefined();
  });
});
