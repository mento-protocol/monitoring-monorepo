/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InfoPopover } from "@/components/info-popover";

describe("InfoPopover", () => {
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

  it("links the opened trigger to the rendered tooltip", () => {
    act(() => {
      root.render(
        <InfoPopover label="About health" content="Oracle freshness details" />,
      );
    });

    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-describedby")).toBeNull();

    act(() => {
      button.click();
    });

    const tooltip = container.querySelector('[role="tooltip"]')!;
    const tooltipId = tooltip.getAttribute("id");
    expect(tooltipId).toBeTruthy();
    expect(button.getAttribute("aria-controls")).toBe(tooltipId);
    expect(button.getAttribute("aria-describedby")).toBe(tooltipId);
  });
});
