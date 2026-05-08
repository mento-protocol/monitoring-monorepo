/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * axe-core accessibility checks for the dashboard's loading skeletons.
 *
 * Loading states are easy to forget. The risk we want a deterministic alarm
 * against: a refactor strips the `role="status"` + `aria-live="polite"`
 * wrapper, leaving an icon-only animation that screen readers never see.
 *
 * This file pairs cheap structural assertions (label text, role) with axe
 * runs to catch both the "empty accessible name" anti-pattern and any
 * future ARIA-attribute typo.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";
import {
  ChartSkeleton,
  PageShellSkeleton,
  TableSkeleton,
  TileGridSkeleton,
} from "@/components/skeletons";

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

describe("Skeleton a11y", () => {
  it("TableSkeleton has the polite live region label and zero axe violations", async () => {
    render(<TableSkeleton rows={3} cols={4} />);
    const region = container.querySelector('[role="status"]');
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.getAttribute("aria-label")).toBe("Loading table");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("TileGridSkeleton labels itself 'Loading metrics' and passes axe", async () => {
    render(<TileGridSkeleton count={4} />);
    const region = container.querySelector('[role="status"]');
    expect(region?.getAttribute("aria-label")).toBe("Loading metrics");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("ChartSkeleton labels itself 'Loading chart' and passes axe", async () => {
    render(<ChartSkeleton aspect="16 / 9" />);
    const region = container.querySelector('[role="status"]');
    expect(region?.getAttribute("aria-label")).toBe("Loading chart");
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("PageShellSkeleton wraps everything in a single live region (no nested role=status)", async () => {
    render(<PageShellSkeleton />);
    const wrapper = container.querySelector('[aria-live="polite"]');
    expect(wrapper?.getAttribute("aria-label")).toBe("Loading");
    // Inner skeletons go presentational — see `liveRegion` helper in
    // src/components/skeletons.tsx. axe would otherwise flag dueling live
    // regions on the same announcement.
    const nested = wrapper?.querySelectorAll('[role="status"]');
    expect(nested?.length).toBe(0);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
