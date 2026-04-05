/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let rafQueue: FrameRequestCallback[];

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
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

  it("shows a +N overflow indicator when pills exceed maxHeight", () => {
    act(() => {
      root.render(<TagPills tags={["One", "Two", "Three"]} maxHeight={48} />);
    });

    const pillRects = [
      { top: 0, bottom: 16 },
      { top: 20, bottom: 36 },
      { top: 40, bottom: 64 },
    ];

    const containerEl = container.querySelector("div[style]") as HTMLDivElement;
    expect(containerEl).not.toBeNull();

    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 48,
      width: 200,
      height: 48,
      toJSON: () => ({}),
    });

    const pills = containerEl.querySelectorAll("span");
    pills.forEach((pill, index) => {
      vi.spyOn(pill, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: pillRects[index].top,
        top: pillRects[index].top,
        left: 0,
        right: 80,
        bottom: pillRects[index].bottom,
        width: 80,
        height: pillRects[index].bottom - pillRects[index].top,
        toJSON: () => ({}),
      });
    });

    act(() => {
      const cb = rafQueue.shift();
      cb?.(0);
    });

    const overflow = container.querySelector("[data-overflow]");
    expect(overflow).not.toBeNull();
    expect(overflow!.textContent).toBe("+1");
  });
});
