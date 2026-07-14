/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StablesChangesTable } from "./stables-changes-table";
import { DEFAULT_SUPPLY_CHANGE_MIN_USD } from "../_lib/aggregate";
import type { StableSupplyChangeEvent } from "../_lib/types";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderThresholdInput({
  value = DEFAULT_SUPPLY_CHANGE_MIN_USD,
  onChange = vi.fn(),
  onReset = vi.fn(),
}: {
  value?: number;
  onChange?: (next: number) => void;
  onReset?: () => void;
} = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <StablesChangesTable
        events={[]}
        minimumUsdValue={value}
        onMinimumUsdValueChange={onChange}
        onMinimumUsdValueReset={onReset}
        isLoading={false}
        hasError={false}
        hasSettled={true}
        capped={false}
        unpricedEventsCount={0}
      />,
    );
  });

  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Minimum USD-equivalent supply change"]',
  );
  expect(input).toBeTruthy();
  return { input: input as HTMLInputElement, onChange, onReset };
}

function changeEvent(index: number): StableSupplyChangeEvent {
  return {
    id: `change-${index}`,
    chainId: 42220,
    tokenAddress: "0xusd",
    tokenSymbol: "USDm",
    tokenDecimals: 18,
    source: "RESERVE",
    kind: "RESERVE_MINT",
    counterparty: "0xcounterparty",
    caller: `0x${String(index).padStart(40, "0")}`,
    txTo: "0xto",
    isProtocolOwnedCaller: true,
    amount: "1000000000000000000000",
    txHash: `0x${String(index).padStart(64, "0")}`,
    blockNumber: String(index),
    blockTimestamp: String(1_780_617_600 + index),
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  expect(setter).toBeTruthy();

  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
});

describe("StablesChangesTable", () => {
  it("explains the display threshold in the empty capped state", () => {
    const html = renderToStaticMarkup(
      <StablesChangesTable
        events={[]}
        minimumUsdValue={DEFAULT_SUPPLY_CHANGE_MIN_USD}
        onMinimumUsdValueChange={() => undefined}
        onMinimumUsdValueReset={() => undefined}
        isLoading={false}
        hasError={false}
        hasSettled={true}
        capped={true}
        unpricedEventsCount={0}
      />,
    );

    expect(html).toContain("No supply changes at or above");
    expect(html).toContain("$1,000.00 equivalent");
    expect(html).toContain("the most recent fetched rows");
    expect(html).toContain("Minimum USD-equivalent supply change");
  });

  it("surfaces unpriced visible rows in the header", () => {
    const html = renderToStaticMarkup(
      <StablesChangesTable
        events={[
          {
            id: "change-1",
            chainId: 42220,
            tokenAddress: "0xusd",
            tokenSymbol: "USDm",
            tokenDecimals: 18,
            source: "RESERVE",
            kind: "RESERVE_MINT",
            counterparty: "0xcounterparty",
            caller: "0xcaller",
            txTo: "0xto",
            isProtocolOwnedCaller: true,
            amount: "1000000000000000000",
            txHash: "0xtx",
            blockNumber: "1",
            blockTimestamp: "1780617600",
          },
        ]}
        minimumUsdValue={1}
        onMinimumUsdValueChange={() => undefined}
        onMinimumUsdValueReset={() => undefined}
        isLoading={false}
        hasError={false}
        hasSettled={true}
        capped={false}
        unpricedEventsCount={1}
      />,
    );

    expect(html).toContain("Hiding changes below $1.00 equivalent");
    expect(html).toContain("Keeping 1 unpriced event visible");
  });

  it("keeps partial decimal drafts local until blur restores the committed value", () => {
    const onChange = vi.fn();
    const { input } = renderThresholdInput({ onChange });

    setInputValue(input, "1.");

    expect(input.value).toBe("1.");
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(input.value).toBe(String(DEFAULT_SUPPLY_CHANGE_MIN_USD));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits valid decimal drafts on Enter", () => {
    const onChange = vi.fn();
    const { input } = renderThresholdInput({ onChange });

    setInputValue(input, "1.5");

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(input.value).toBe("1.5");
    expect(onChange).toHaveBeenCalledWith(1.5);
  });

  it("limits rendered rows to 50 and paginates the remaining changes", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <StablesChangesTable
          events={Array.from({ length: 55 }, (_, index) => changeEvent(index))}
          minimumUsdValue={DEFAULT_SUPPLY_CHANGE_MIN_USD}
          onMinimumUsdValueChange={() => undefined}
          onMinimumUsdValueReset={() => undefined}
          isLoading={false}
          hasError={false}
          hasSettled={true}
          capped={false}
          unpricedEventsCount={0}
        />,
      );
    });

    expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
    expect(container.textContent).toContain(
      "Showing 1-50 of 55 matching events.",
    );
    expect(container.textContent).toContain("Page 1 of 2");

    const nextButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    );
    expect(nextButton).toBeTruthy();

    act(() => {
      nextButton?.click();
    });

    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(container.textContent).toContain(
      "Showing 51-55 of 55 matching events.",
    );
    expect(container.textContent).toContain("Page 2 of 2");
  });

  it("resets to the first page when the matching page count changes", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const renderEvents = (eventCount: number) => {
      root?.render(
        <StablesChangesTable
          events={Array.from({ length: eventCount }, (_, index) =>
            changeEvent(index),
          )}
          minimumUsdValue={DEFAULT_SUPPLY_CHANGE_MIN_USD}
          onMinimumUsdValueChange={() => undefined}
          onMinimumUsdValueReset={() => undefined}
          isLoading={false}
          hasError={false}
          hasSettled={true}
          capped={false}
          unpricedEventsCount={0}
        />,
      );
    };

    act(() => renderEvents(55));

    const nextButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    );
    act(() => {
      nextButton?.click();
    });

    expect(container.textContent).toContain(
      "Showing 51-55 of 55 matching events.",
    );

    act(() => renderEvents(1));
    expect(container.textContent).toContain(
      "Showing 1-1 of 1 matching events.",
    );

    act(() => renderEvents(55));
    expect(container.textContent).toContain(
      "Showing 1-50 of 55 matching events.",
    );
    expect(container.textContent).toContain("Page 1 of 2");
  });

  describe("loading-branch skeleton parity", () => {
    // These assert the reserved-geometry INVARIANT (a single `minHeight`
    // constant applied to every branch), not just that each branch renders
    // without crashing — a table-shaped skeleton that happened to reserve a
    // different height than the error/empty/loaded branches would still
    // pass a render-only test but reintroduce the production CLS jump.
    function renderBranch(props: {
      events: ReadonlyArray<StableSupplyChangeEvent>;
      isLoading: boolean;
      hasError: boolean;
      hasSettled?: boolean;
    }): HTMLDivElement {
      const div = document.createElement("div");
      document.body.appendChild(div);
      const branchRoot = createRoot(div);
      act(() => {
        branchRoot.render(
          <StablesChangesTable
            events={props.events}
            minimumUsdValue={DEFAULT_SUPPLY_CHANGE_MIN_USD}
            onMinimumUsdValueChange={() => undefined}
            onMinimumUsdValueReset={() => undefined}
            isLoading={props.isLoading}
            hasError={props.hasError}
            hasSettled={props.hasSettled ?? false}
            capped={false}
            unpricedEventsCount={0}
          />,
        );
      });
      return div;
    }

    function reservedHeight(div: HTMLDivElement): string | undefined {
      const reserved = div.querySelector<HTMLElement>("[style]");
      return reserved?.style.minHeight;
    }

    it("renders a table-shaped skeleton (header + 20 rows) instead of a bare text line", () => {
      const div = renderBranch({
        events: [],
        isLoading: true,
        hasError: false,
      });

      expect(div.textContent).not.toContain("Loading supply changes");
      const table = div.querySelector<HTMLElement>(
        '[role="status"][aria-label="Loading table"]',
      );
      expect(table).not.toBeNull();
      // `variant="rows"` renders one full-width header bar (measured ≈36px)
      // followed by a `divide-y` wrapper holding one bar per skeleton row.
      const rows = table!.querySelector(".divide-y");
      expect(rows).not.toBeNull();
      expect(rows!.children).toHaveLength(20);
    });

    it("reserves the identical minHeight across the transitional loading, error, and pre-settle empty branches", () => {
      const loading = renderBranch({
        events: [],
        isLoading: true,
        hasError: false,
      });
      const error = renderBranch({
        events: [],
        isLoading: false,
        hasError: true,
      });
      // Pre-settle empty (hasSettled=false): a first load that resolves empty
      // before settling still reserves the floor so the skeleton→empty swap
      // doesn't shrink the card.
      const empty = renderBranch({
        events: [],
        isLoading: false,
        hasError: false,
        hasSettled: false,
      });

      const loadingHeight = reservedHeight(loading);
      expect(loadingHeight).toBeTruthy();
      expect(reservedHeight(error)).toBe(loadingHeight);
      expect(reservedHeight(empty)).toBe(loadingHeight);

      [loading, error, empty].forEach((div) => div.remove());
    });

    it("does NOT floor the settled filtered-empty branch, so a fully-filtered result sizes naturally", () => {
      // Once settled (hasSettled=true), raising "Min value" above every row
      // leaves the empty message — it must NOT reserve the full 20-row floor,
      // or the card holds ~967px of dead whitespace below the message forever
      // (the same defect the settled loaded branch already avoids).
      const settledEmpty = renderBranch({
        events: [],
        isLoading: false,
        hasError: false,
        hasSettled: true,
      });

      expect(settledEmpty.textContent).toContain(
        "No supply changes at or above",
      );
      expect(reservedHeight(settledEmpty)).toBeFalsy();

      settledEmpty.remove();
    });

    it("does NOT floor the settled loaded-with-data branch, so a short filtered result sizes naturally", () => {
      // The floor exists to stop wave-growth DURING loading. A genuinely
      // small, settled result set (e.g. after raising "Min value") must NOT
      // reserve the full 20-row skeleton height, or the card holds hundreds
      // of px of dead whitespace below the table forever.
      const loaded = renderBranch({
        events: [changeEvent(0), changeEvent(1)],
        isLoading: false,
        hasError: false,
      });

      // Two real rows render...
      expect(loaded.querySelectorAll("tbody tr")).toHaveLength(2);
      // ...and no element carries the reserved 20-row minHeight floor.
      expect(reservedHeight(loaded)).toBeFalsy();

      loaded.remove();
    });

    it("keeps the real filter/header row mounted during loading (no data needed to render it)", () => {
      const div = renderBranch({
        events: [],
        isLoading: true,
        hasError: false,
      });

      expect(
        div.querySelector(
          'input[aria-label="Minimum USD-equivalent supply change"]',
        ),
      ).not.toBeNull();
      expect(div.textContent).toContain("Supply changes");
    });
  });
});
