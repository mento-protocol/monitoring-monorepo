/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TagPills } from "@/components/tag-pills";

// Stub ResizeObserver for jsdom
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ??
  (ResizeObserverStub as unknown as typeof ResizeObserver);

describe("TagPills", () => {
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

  it("renders nothing when tags is empty", () => {
    act(() => {
      root.render(<TagPills tags={[]} />);
    });
    expect(container.innerHTML).toBe("");
  });

  it("renders pill elements for each tag", () => {
    act(() => {
      root.render(<TagPills tags={["Whale", "MEV Bot"]} />);
    });
    const pills = container.querySelectorAll("span:not([data-overflow])");
    expect(pills.length).toBe(2);
    expect(pills[0].textContent).toBe("Whale");
    expect(pills[1].textContent).toBe("MEV Bot");
  });

  it("pills have the expected styling classes", () => {
    act(() => {
      root.render(<TagPills tags={["CEX"]} />);
    });
    const pill = container.querySelector("span");
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain("rounded-full");
    expect(pill!.className).toContain("bg-slate-700");
    expect(pill!.className).toContain("text-slate-300");
    expect(pill!.className).toContain("text-[10px]");
  });

  it("renders a single tag without overflow indicator", () => {
    act(() => {
      root.render(<TagPills tags={["DAO"]} />);
    });
    const overflow = container.querySelector("[data-overflow]");
    expect(overflow).toBeNull();
  });
});
