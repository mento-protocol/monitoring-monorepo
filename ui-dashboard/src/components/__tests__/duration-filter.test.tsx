/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurationRangeInputs } from "@/components/breach-history/duration-filter";

let container: HTMLElement | null = null;
let root: Root | null = null;

function setup() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function minInput(): HTMLInputElement {
  const input = container?.querySelector<HTMLInputElement>(
    'input[aria-label="Minimum breach duration"]',
  );
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("DurationRangeInputs", () => {
  it("syncs draft text from committed props when the field is not being edited", () => {
    setup();
    const onMinCommit = vi.fn();
    const onMaxCommit = vi.fn();

    act(() => {
      root?.render(
        <DurationRangeInputs
          minSeconds={3600}
          maxSeconds={null}
          onMinCommit={onMinCommit}
          onMaxCommit={onMaxCommit}
        />,
      );
    });
    expect(minInput().value).toBe("1h 0m");

    act(() => {
      root?.render(
        <DurationRangeInputs
          minSeconds={7200}
          maxSeconds={null}
          onMinCommit={onMinCommit}
          onMaxCommit={onMaxCommit}
        />,
      );
    });
    expect(minInput().value).toBe("2h 0m");
  });

  it("preserves local draft text while the field is focused", () => {
    setup();
    const onMinCommit = vi.fn();
    const onMaxCommit = vi.fn();

    act(() => {
      root?.render(
        <DurationRangeInputs
          minSeconds={3600}
          maxSeconds={null}
          onMinCommit={onMinCommit}
          onMaxCommit={onMaxCommit}
        />,
      );
    });
    const input = minInput();
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    setInputValue(input, "90m");

    act(() => {
      root?.render(
        <DurationRangeInputs
          minSeconds={7200}
          maxSeconds={null}
          onMinCommit={onMinCommit}
          onMaxCommit={onMaxCommit}
        />,
      );
    });

    expect(minInput().value).toBe("90m");
  });
});
