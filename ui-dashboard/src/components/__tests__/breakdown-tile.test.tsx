/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BreakdownTile } from "@/components/breakdown-tile";

// The loading branch used to render a bare "…" and omit the 24h/7d/30d
// breakdown rows, so the tile grew when data landed (114 -> 164px on
// /stables). These tests pin the loading branch to reserve the same 3 rows
// the loaded branch renders.

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

const BASE_PROPS = {
  label: "Circulating supply",
  total: 1_000_000,
  sub24h: 10_000,
  sub7d: 20_000,
  sub30d: 30_000,
  hasError: false,
  format: (v: number) => `$${v}`,
};

function getSubRows(): HTMLElement[] {
  const row = container.querySelector(".mt-1\\.5.flex.flex-wrap");
  if (!row) return [];
  return Array.from(row.children) as HTMLElement[];
}

describe("BreakdownTile loading parity", () => {
  it("reserves 3 breakdown rows while loading, matching the loaded row count", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading total={null} />);
    const loadingRows = getSubRows();
    expect(loadingRows).toHaveLength(3);

    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} />);
    const loadedRows = getSubRows();
    expect(loadedRows).toHaveLength(3);
  });

  it("renders a shimmer placeholder (not real values) for each row while loading", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading total={null} />);
    const rows = getSubRows();
    rows.forEach((row) => {
      const shimmer = row.querySelector(".animate-pulse");
      expect(shimmer).not.toBeNull();
    });
    expect(container.textContent).not.toContain("$10000");
  });

  it("sizes each loading placeholder (w-14) to track a representative formatted value so wrap parity holds", () => {
    // A too-narrow placeholder can let the flex-wrap sub-row settle on fewer
    // lines while loading than the loaded formatted values (e.g. "+$450.3K")
    // occupy, re-opening the height jump. w-14 (~56px) matches a typical
    // formatUSD/formatSignedUSD width so the loading line count matches loaded.
    render(<BreakdownTile {...BASE_PROPS} isLoading total={null} />);
    getSubRows().forEach((row) => {
      const shimmer = row.querySelector(".animate-pulse");
      expect(shimmer).not.toBeNull();
      expect(shimmer!.className).toContain("w-14");
    });
  });

  it("shows the real formatted sub-values once loaded", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} />);
    expect(container.textContent).toContain("$10000");
    expect(container.textContent).toContain("$20000");
    expect(container.textContent).toContain("$30000");
  });

  it("still omits the breakdown rows on error once loaded (unchanged behavior)", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} hasError />);
    expect(getSubRows()).toHaveLength(0);
  });

  it("still omits the breakdown rows when total is null and not loading (unchanged behavior)", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} total={null} />);
    expect(getSubRows()).toHaveLength(0);
  });
});
