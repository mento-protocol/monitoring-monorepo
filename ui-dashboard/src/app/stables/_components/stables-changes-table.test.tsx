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
});
