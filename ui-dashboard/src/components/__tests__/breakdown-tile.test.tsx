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

// The empty-state branch (loaded, no error, `total === null`) grid-stacks
// an invisible spacer mirroring the row shapes with the visible message —
// distinct markup from `getSubRows()`'s `mt-1.5 flex flex-wrap` sub-rows
// div, so it needs its own query.
function getEmptyStateSpacerRows(): HTMLElement[] {
  const spacer = container.querySelector(".invisible.flex.flex-wrap");
  if (!spacer) return [];
  return Array.from(spacer.children) as HTMLElement[];
}

function getEmptyStateMessage(): HTMLElement | null {
  return container.querySelector(".invisible.flex.flex-wrap + p");
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

  it("still omits the breakdown rows and the empty state on error once loaded (unchanged behavior)", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} hasError />);
    expect(getSubRows()).toHaveLength(0);
    expect(getEmptyStateSpacerRows()).toHaveLength(0);
    expect(getEmptyStateMessage()).toBeNull();
  });
});

// A caller can legitimately resolve with `total === null` after loading
// (MoverTile has no expansion/contraction this window; a bridge window can
// resolve zero snapshots). The loading arm above reserves 3 sub-rows, so
// omitting the block entirely here would shrink the tile the moment a
// no-data window resolves — the same height jump the loading-row
// reservation was written to close.
describe("BreakdownTile empty-state parity (loaded, no error, total === null)", () => {
  const EMPTY_PROPS = { ...BASE_PROPS, total: null, isLoading: false };

  it("renders a reserved-height empty state instead of omitting the block", () => {
    render(<BreakdownTile {...EMPTY_PROPS} />);
    expect(getSubRows()).toHaveLength(0);
    expect(getEmptyStateSpacerRows()).toHaveLength(3);
  });

  it("sizes the empty-state spacer slots identically to the loading placeholders (w-14/h-3, same labels)", () => {
    render(<BreakdownTile {...EMPTY_PROPS} />);
    const spacerRows = getEmptyStateSpacerRows();
    expect(spacerRows.map((r) => r.textContent?.trim())).toEqual([
      "24h",
      "7d",
      "30d",
    ]);
    spacerRows.forEach((row) => {
      const box = row.querySelector("span:last-child");
      expect(box).not.toBeNull();
      expect(box!.className).toContain("w-14");
      expect(box!.className).toContain("h-3");
    });
  });

  it("hides the spacer from assistive tech and shows a real message instead of a skeleton", () => {
    render(<BreakdownTile {...EMPTY_PROPS} />);
    const spacer = container.querySelector(".invisible.flex.flex-wrap");
    expect(spacer).not.toBeNull();
    expect(spacer!.getAttribute("aria-hidden")).toBe("true");

    // Distinguishable from the loading skeleton: no shimmer/pulse anywhere
    // in the empty-state block, and no bg-fill placeholder boxes either.
    expect(container.querySelector(".animate-pulse")).toBeNull();

    const message = getEmptyStateMessage();
    expect(message).not.toBeNull();
    expect(message!.textContent).toBe("No data this window");
  });

  it("supports a caller-supplied empty-state message, defaulting when omitted", () => {
    render(
      <BreakdownTile
        {...EMPTY_PROPS}
        emptyStateMessage="No expansion this window"
      />,
    );
    expect(getEmptyStateMessage()!.textContent).toBe(
      "No expansion this window",
    );
  });

  it("does not render the empty state while loading or on error", () => {
    render(<BreakdownTile {...EMPTY_PROPS} isLoading />);
    expect(getEmptyStateSpacerRows()).toHaveLength(0);

    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(<BreakdownTile {...EMPTY_PROPS} hasError />);
    expect(getEmptyStateSpacerRows()).toHaveLength(0);
    expect(getEmptyStateMessage()).toBeNull();
  });
});
