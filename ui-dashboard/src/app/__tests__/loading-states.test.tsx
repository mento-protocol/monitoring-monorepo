/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RootLoading from "@/app/loading";
import PoolDetailLoading from "@/app/pool/[poolId]/loading";
import AddressBookLoading from "@/app/address-book/loading";

// Each route-level loading UI must expose exactly one aria-live region so
// screen readers don't announce nested status regions redundantly. Keeping
// this invariant in a test pins it against future accidental additions.

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

function countLiveRegions(): number {
  return container.querySelectorAll('[aria-live="polite"]').length;
}

describe("route-level loading UIs", () => {
  it("RootLoading renders exactly one polite live region (PageShellSkeleton wrapper)", () => {
    render(<RootLoading />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
  });

  it("PoolDetailLoading renders exactly one polite live region (on TableSkeleton)", () => {
    render(<PoolDetailLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("AddressBookLoading renders exactly one polite live region (on TableSkeleton)", () => {
    render(<AddressBookLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("AddressBookLoading skeleton matches the real table shape (10 cols)", () => {
    render(<AddressBookLoading />);
    const table = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading table"]',
    );
    expect(table).not.toBeNull();
    const [header] = Array.from(table!.children) as HTMLElement[];
    expect(header!.children).toHaveLength(10);
  });

  it("PoolDetailLoading skeleton matches the real page shape (7 tabs, 6-col table)", () => {
    render(<PoolDetailLoading />);
    const table = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading table"]',
    );
    expect(table).not.toBeNull();
    const [header] = Array.from(table!.children) as HTMLElement[];
    expect(header!.children).toHaveLength(6);

    // Tab strip: 7 placeholder bars inside a flex container with a bottom border
    const tabStrip = container.querySelector(".flex.gap-1.border-b");
    expect(tabStrip).not.toBeNull();
    expect(tabStrip!.children).toHaveLength(7);
  });

  it("PoolDetailLoading reserves the header card, health bar, and charts row (CLS guard)", () => {
    render(<PoolDetailLoading />);

    // Header card: 5-col stat grid mirroring PoolHeader's <dl>.
    const statGrid = container.querySelector(".lg\\:grid-cols-5");
    expect(statGrid).not.toBeNull();
    expect(statGrid!.children).toHaveLength(5);

    // Charts row: two chart cards + reserves panel, mirroring PoolChartsRow.
    const chartsRow = container.querySelector(".lg\\:grid-cols-3");
    expect(chartsRow).not.toBeNull();
    expect(chartsRow!.children).toHaveLength(3);

    // Chart card plot areas reserve ROW_CHART_HEIGHT_PX (200) so the real
    // TimeSeriesChartCards stream in without pushing the tab strip down.
    expect(container.querySelectorAll(".h-\\[200px\\]")).toHaveLength(2);
  });
});
