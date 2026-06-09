/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tooltip } from "@/components/tooltip";

describe("Tooltip", () => {
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

  it("links the trigger to the rendered tooltip without native title", () => {
    act(() => {
      root.render(
        <Tooltip label="About health" content="Oracle freshness details" />,
      );
    });

    const trigger = container.querySelector('[aria-label="About health"]')!;
    const tooltip = container.querySelector('[role="tooltip"]')!;
    const tooltipId = tooltip.getAttribute("id");

    expect(tooltipId).toBeTruthy();
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltipId);
    expect(trigger.getAttribute("title")).toBeNull();
    expect(tooltip.textContent).toContain("Oracle freshness details");
  });

  it("can attach tooltip semantics directly to an interactive child", () => {
    act(() => {
      root.render(
        <Tooltip content="Shows all volume" asChild>
          <button type="button">All</button>
        </Tooltip>,
      );
    });

    const button = container.querySelector("button")!;
    const tooltipId = button.getAttribute("aria-describedby");
    expect(tooltipId).toBeTruthy();
    expect(button.getAttribute("title")).toBeNull();
    expect(
      container.ownerDocument.getElementById(tooltipId!)?.textContent,
    ).toContain("Shows all volume");
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
  });
});
