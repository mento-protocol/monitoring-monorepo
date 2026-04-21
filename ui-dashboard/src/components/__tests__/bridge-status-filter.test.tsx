/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BridgeStatusFilter } from "@/components/bridge-status-filter";
import type { BridgeStatus } from "@/lib/types";

const OPTIONS: readonly BridgeStatus[] = [
  "PENDING",
  "SENT",
  "ATTESTED",
  "QUEUED_INBOUND",
  "DELIVERED",
];

function pillByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  );
  const match = buttons.find((b) => b.textContent?.trim() === label);
  if (!match) throw new Error(`No pill with label ${label}`);
  return match;
}

describe("BridgeStatusFilter", () => {
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

  it("adds an unselected status on click", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={["DELIVERED"]}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Sent").click();
    });
    expect(onChange).toHaveBeenCalledWith(["DELIVERED", "SENT"]);
  });

  it("removes a selected status on click", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={["SENT", "DELIVERED"]}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Sent").click();
    });
    expect(onChange).toHaveBeenCalledWith(["DELIVERED"]);
  });

  it("'All' shortcut resets to the full options list", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={["SENT"]}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "All").click();
    });
    expect(onChange).toHaveBeenCalledWith([...OPTIONS]);
  });

  it("aria-pressed reflects membership in `selected`", () => {
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={["SENT", "DELIVERED"]}
          onChange={vi.fn()}
        />,
      );
    });
    expect(pillByLabel(container, "Sent").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      pillByLabel(container, "Delivered").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(pillByLabel(container, "Pending").getAttribute("aria-pressed")).toBe(
      "false",
    );
    // 'All' is only pressed when every option is selected.
    expect(pillByLabel(container, "All").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("clicking the last selected pill emits an empty array", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={["DELIVERED"]}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Delivered").click();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("preserves orphan selected values when toggling (subset invariant violated)", () => {
    // Regression guard: old `toggle` built the next array by filtering
    // `options`, which dropped any selected value that wasn't in options.
    // The fix operates on `selected` directly — toggle of a known option
    // must still preserve unknown-to-options values the parent passed in.
    const onChange = vi.fn();
    const selectedWithOrphan = [
      "SENT",
      "CANCELLED",
    ] as unknown as readonly BridgeStatus[];
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={selectedWithOrphan}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Delivered").click();
    });
    expect(onChange).toHaveBeenCalledWith(["SENT", "CANCELLED", "DELIVERED"]);
  });
});
