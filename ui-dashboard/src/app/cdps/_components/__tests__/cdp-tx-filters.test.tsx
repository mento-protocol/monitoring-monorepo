/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CdpTxAddressFilter,
  CdpTxMarketFilter,
  CdpTxTypeFilter,
  TX_FILTER_TYPE_ORDER,
  normalizeAddressFilter,
} from "../cdp-tx-filters";
import type { BadgeKind } from "../../_lib/transactions";

const MARKETS = [
  { id: "celo-mainnet_1", symbol: "GBPm" },
  { id: "celo-mainnet_2", symbol: "CHFm" },
  { id: "celo-mainnet_3", symbol: "JPYm" },
];

function pillByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  );
  const match = buttons.find((b) => b.textContent?.trim() === label);
  if (!match) throw new Error(`No pill with label ${label}`);
  return match;
}

describe("CdpTxTypeFilter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders an All pill plus one per BadgeKind in TX_FILTER_TYPE_ORDER", () => {
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={null}
          onChange={vi.fn()}
        />,
      );
    });
    const radios = container.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(TX_FILTER_TYPE_ORDER.length + 1);
  });

  it("shows the renamed `Rebalance` label, not `SP Rebalance`", () => {
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={null}
          onChange={vi.fn()}
        />,
      );
    });
    expect(() => pillByLabel(container, "Rebalance")).not.toThrow();
    expect(() => pillByLabel(container, "SP Rebalance")).toThrow();
  });

  it("clicking a type pill emits the BadgeKind", () => {
    const onChange = vi.fn<(next: BadgeKind | null) => void>();
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={null}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Open Trove").click();
    });
    expect(onChange).toHaveBeenCalledWith("troveOpen");
  });

  it("All pill is aria-checked when selected=null", () => {
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={null}
          onChange={vi.fn()}
        />,
      );
    });
    expect(pillByLabel(container, "All").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      pillByLabel(container, "Liquidation").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("selected pill is aria-checked; All flips off", () => {
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={"liquidation"}
          onChange={vi.fn()}
        />,
      );
    });
    expect(
      pillByLabel(container, "Liquidation").getAttribute("aria-checked"),
    ).toBe("true");
    expect(pillByLabel(container, "All").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("clicking the active pill is a no-op (no onChange)", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={"liquidation"}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Liquidation").click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking All while a type is selected emits null", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={"liquidation"}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "All").click();
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("ArrowRight from All advances to the first type option", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <CdpTxTypeFilter
          options={TX_FILTER_TYPE_ORDER}
          selected={null}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "All").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenCalledWith(TX_FILTER_TYPE_ORDER[0]);
  });
});

describe("CdpTxMarketFilter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders an All pill plus one per market, labelled by symbol", () => {
    act(() => {
      root.render(
        <CdpTxMarketFilter
          options={MARKETS}
          selected={null}
          onChange={vi.fn()}
        />,
      );
    });
    expect(() => pillByLabel(container, "All")).not.toThrow();
    expect(() => pillByLabel(container, "GBPm")).not.toThrow();
    expect(() => pillByLabel(container, "CHFm")).not.toThrow();
    expect(() => pillByLabel(container, "JPYm")).not.toThrow();
  });

  it("clicking a market pill emits the market id (not the symbol)", () => {
    const onChange = vi.fn<(next: string | null) => void>();
    act(() => {
      root.render(
        <CdpTxMarketFilter
          options={MARKETS}
          selected={null}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "GBPm").click();
    });
    expect(onChange).toHaveBeenCalledWith("celo-mainnet_1");
  });

  it("selecting by id flips the matching market's aria-checked", () => {
    act(() => {
      root.render(
        <CdpTxMarketFilter
          options={MARKETS}
          selected={"celo-mainnet_2"}
          onChange={vi.fn()}
        />,
      );
    });
    expect(pillByLabel(container, "CHFm").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(pillByLabel(container, "GBPm").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(pillByLabel(container, "All").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("clicking All from a selected market emits null", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <CdpTxMarketFilter
          options={MARKETS}
          selected={"celo-mainnet_2"}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "All").click();
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("CdpTxAddressFilter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function getInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("No address input rendered");
    return input;
  }

  it("renders an empty input when value is the empty string", () => {
    act(() => {
      root.render(<CdpTxAddressFilter value="" onChange={vi.fn()} />);
    });
    const input = getInput();
    expect(input.value).toBe("");
    // The aria-label is the load-bearing accessible name; if a future
    // refactor strips it the screen-reader experience regresses silently.
    expect(input.getAttribute("aria-label")).toBe(
      "Filter CDP transactions by trove owner address",
    );
  });

  it("typing into the input emits the raw value (no normalization)", () => {
    const onChange = vi.fn<(next: string) => void>();
    act(() => {
      root.render(<CdpTxAddressFilter value="" onChange={onChange} />);
    });
    const input = getInput();
    act(() => {
      // Mimic the user typing — set value then dispatch the React-aware
      // input event so the synthetic event fires through React's tree.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "  0xAbCd  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Component is controlled, so it forwards the raw (un-normalized)
    // string. Normalization happens at the comparison site via
    // `normalizeAddressFilter`.
    expect(onChange).toHaveBeenCalledWith("  0xAbCd  ");
  });

  it("renders the controlled value verbatim, preserving whitespace + case", () => {
    act(() => {
      root.render(<CdpTxAddressFilter value="  0xAbCd  " onChange={vi.fn()} />);
    });
    expect(getInput().value).toBe("  0xAbCd  ");
  });

  it("renders disabled with a hint when the snapshot query isn't ready", () => {
    act(() => {
      root.render(
        <CdpTxAddressFilter
          value=""
          onChange={vi.fn()}
          disabled
          disabledHint="(unavailable while indexer syncs)"
        />,
      );
    });
    const input = getInput();
    expect(input.disabled).toBe(true);
    // Hint sits as a sibling span — assert it shows up in the rendered DOM
    // so users see *why* the input is greyed out instead of guessing.
    expect(container.textContent).toContain(
      "(unavailable while indexer syncs)",
    );
  });

  it("omits the disabled hint when disabled is false", () => {
    act(() => {
      root.render(
        <CdpTxAddressFilter
          value=""
          onChange={vi.fn()}
          disabledHint="(should not render)"
        />,
      );
    });
    expect(getInput().disabled).toBe(false);
    expect(container.textContent).not.toContain("(should not render)");
  });
});

describe("normalizeAddressFilter", () => {
  it("trims whitespace and lowercases the address", () => {
    expect(normalizeAddressFilter("  0xAbCd  ")).toBe("0xabcd");
  });

  it("returns the empty string for blank input (signal to disable the filter)", () => {
    expect(normalizeAddressFilter("")).toBe("");
    expect(normalizeAddressFilter("   ")).toBe("");
  });

  it("is idempotent on already-normalized values", () => {
    expect(normalizeAddressFilter("0xabcd1234")).toBe("0xabcd1234");
  });
});
