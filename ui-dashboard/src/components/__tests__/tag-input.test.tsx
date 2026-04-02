/** @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TagInput } from "@/components/tag-input";

describe("TagInput", () => {
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

  it("renders existing tags as removable pills", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <TagInput
          tags={["Whale", "CEX"]}
          onChange={onChange}
          suggestions={[]}
        />,
      );
    });
    const pills = container.querySelectorAll("span.inline-flex");
    expect(pills.length).toBe(2);
    expect(pills[0].textContent).toContain("Whale");
    expect(pills[1].textContent).toContain("CEX");
  });

  it("calls onChange without removed tag when X is clicked", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <TagInput
          tags={["Whale", "CEX"]}
          onChange={onChange}
          suggestions={[]}
        />,
      );
    });
    // Click the remove button on the first tag
    const removeButtons = container.querySelectorAll(
      'button[aria-label^="Remove"]',
    );
    expect(removeButtons.length).toBe(2);
    act(() => {
      (removeButtons[0] as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith(["CEX"]);
  });

  it("adds a freeform tag on Enter", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <TagInput tags={[]} onChange={onChange} suggestions={["Whale"]} />,
      );
    });
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      input.focus();
      // Simulate typing
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeInputValueSetter.call(input, "Custom Tag");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenCalledWith(["Custom Tag"]);
  });

  it("shows autocomplete dropdown matching suggestions", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <TagInput
          tags={[]}
          onChange={onChange}
          suggestions={["Whale", "MEV Bot", "Market Maker"]}
        />,
      );
    });
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      input.focus();
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeInputValueSetter.call(input, "Ma");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Should show dropdown with "Market Maker" (contains "Ma")
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const options = listbox!.querySelectorAll('[role="option"]');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toBe("Market Maker");
  });

  it("does not duplicate an already-added tag", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <TagInput
          tags={["Whale"]}
          onChange={onChange}
          suggestions={["Whale"]}
        />,
      );
    });
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      input.focus();
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeInputValueSetter.call(input, "Whale");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    // Should not call onChange because "Whale" is already present
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders empty state with placeholder", () => {
    act(() => {
      root.render(<TagInput tags={[]} onChange={vi.fn()} suggestions={[]} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.placeholder).toBe("Add tags…");
  });
});
