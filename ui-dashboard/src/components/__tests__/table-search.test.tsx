/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TableSearch } from "@/components/table-search";

describe("TableSearch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("keeps focus while typing and syncs external value updates without remount hacks", () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <TableSearch
          value=""
          onChange={onChange}
          ariaLabel="Search swaps"
          debounceMs={150}
        />,
      );
    });

    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      input.focus();
    });
    expect(document.activeElement).toBe(input);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "0xabc");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("0xabc");
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onChange).toHaveBeenCalledWith("0xabc");
    expect(document.activeElement).toBe(input);

    act(() => {
      root.render(
        <TableSearch
          value="0xabc"
          onChange={onChange}
          ariaLabel="Search swaps"
          debounceMs={150}
        />,
      );
    });

    const rerenderedInput = container.querySelector(
      "input",
    ) as HTMLInputElement;
    expect(rerenderedInput).toBe(input);
    expect(rerenderedInput.value).toBe("0xabc");
    expect(document.activeElement).toBe(rerenderedInput);
  });
});
