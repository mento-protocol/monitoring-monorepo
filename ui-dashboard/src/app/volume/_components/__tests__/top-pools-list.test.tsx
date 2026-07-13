/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TopPoolsList, type TopPoolsListEntry } from "../top-pools-list";

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

function render(element: React.ReactElement) {
  act(() => {
    root.render(element);
  });
}

function entry(overrides: Partial<TopPoolsListEntry> = {}): TopPoolsListEntry {
  return {
    poolId: "42220-0xpool",
    name: "USDC/USDm",
    totalUsd: 1_000,
    share: 0.42,
    color: "#6366f1",
    ...overrides,
  };
}

describe("TopPoolsList", () => {
  it("renders a compact 10-row list placeholder while loading, matching the loaded <ol> row rhythm", () => {
    render(
      <TopPoolsList entries={[]} isLoading hasError={false} windowLabel="1M" />,
    );
    const status = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading pool ranking"]',
    );
    expect(status).not.toBeNull();
    expect(status!.tagName).toBe("OL");
    expect(status!.className).toContain("space-y-1.5");
    const skeletonRows = Array.from(status!.children).filter(
      (child) => child.tagName === "LI",
    );
    expect(skeletonRows).toHaveLength(10);

    render(
      <TopPoolsList
        entries={[
          entry({}),
          entry({ poolId: "42220-0xpool2", name: "cUSD/USDT", color: null }),
        ]}
        isLoading={false}
        hasError={false}
        windowLabel="1M"
      />,
    );
    const loadedList = container.querySelector("ol");
    expect(loadedList).not.toBeNull();
    expect(loadedList!.className).toContain("space-y-1.5");
    const loadedRows = Array.from(loadedList!.children).filter(
      (child) => child.tagName === "LI",
    );
    expect(loadedRows).toHaveLength(2);
  });

  it("renders distinct error and empty states instead of the list skeleton", () => {
    render(
      <TopPoolsList entries={[]} isLoading={false} hasError windowLabel="1M" />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load pool ranking.",
    );
    expect(container.querySelector("ol")).toBeNull();

    render(
      <TopPoolsList
        entries={[]}
        isLoading={false}
        hasError={false}
        windowLabel="1M"
      />,
    );
    expect(container.textContent).toContain("No pool volume in this window.");
    expect(container.querySelector("ol")).toBeNull();
  });
});
