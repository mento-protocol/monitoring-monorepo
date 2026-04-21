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

  it("All pill is aria-checked when selected is null (default)", () => {
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={null}
          onChange={vi.fn()}
        />,
      );
    });
    expect(pillByLabel(container, "All").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(pillByLabel(container, "Sent").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(
      pillByLabel(container, "Delivered").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("clicking a status pill emits that status", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={null}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Sent").click();
    });
    expect(onChange).toHaveBeenCalledWith("SENT");
  });

  it("clicking 'All' emits null", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={"SENT"}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "All").click();
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("selected status pill is aria-checked, All and others are not", () => {
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={"DELIVERED"}
          onChange={vi.fn()}
        />,
      );
    });
    expect(
      pillByLabel(container, "Delivered").getAttribute("aria-checked"),
    ).toBe("true");
    expect(pillByLabel(container, "All").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(pillByLabel(container, "Sent").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(pillByLabel(container, "Pending").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("clicking a different pill while one is active switches to the new one", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={"DELIVERED"}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      pillByLabel(container, "Sent").click();
    });
    expect(onChange).toHaveBeenCalledWith("SENT");
  });

  it("uses role=radiogroup and role=radio on buttons", () => {
    act(() => {
      root.render(
        <BridgeStatusFilter
          options={OPTIONS}
          selected={null}
          onChange={vi.fn()}
        />,
      );
    });
    expect(container.querySelector('[role="radiogroup"]')).toBeTruthy();
    const radios = container.querySelectorAll('[role="radio"]');
    // All + 5 status options = 6
    expect(radios).toHaveLength(6);
  });
});
