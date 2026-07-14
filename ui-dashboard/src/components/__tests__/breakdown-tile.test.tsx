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

// The empty-state branch (loaded, no error, `total === null`) and the
// error branch (`hasError`) both render an invisible spacer mirroring the
// row shapes via this same markup — distinct from `getSubRows()`'s
// `mt-1.5 flex flex-wrap` sub-rows div, so it needs its own query. Only the
// empty-state branch pairs it with a visible message (see
// `getEmptyStateMessage`); the error branch renders the spacer alone.
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

  it("reserves the same 3-row footprint on error as it does once loaded, instead of collapsing", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} hasError />);
    expect(getSubRows()).toHaveLength(0);
    expect(getEmptyStateSpacerRows()).toHaveLength(3);
    // The error message renders on the subtitle line (BreakdownTile), not
    // duplicated inside the sub-row block.
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

  it("does not render the empty-state message while loading", () => {
    render(<BreakdownTile {...EMPTY_PROPS} isLoading />);
    expect(getEmptyStateSpacerRows()).toHaveLength(0);
    expect(getEmptyStateMessage()).toBeNull();
  });

  it("reserves the spacer but omits the empty-state message on error (error takes precedence over the empty state)", () => {
    render(<BreakdownTile {...EMPTY_PROPS} hasError />);
    // Same invisible-row technique as the plain empty state, but without
    // its message — hasError renders its own reserved-height spacer (see
    // the "BreakdownTile error-state parity" suite below) rather than the
    // `total === null` empty-state message.
    expect(getEmptyStateSpacerRows()).toHaveLength(3);
    expect(getEmptyStateMessage()).toBeNull();
  });
});

// hasError takes precedence over both the loaded-with-total and the
// total === null empty-state branches once loading finishes: a
// loading-to-error or loaded-to-error transition must not shrink the tile
// by the sub-row block's height. Reserves the same footprint via the same
// invisible-row technique as the total === null empty state, but with no
// visible message here — the "Some chains failed to load" text already
// renders on the subtitle line, not inside the sub-row block.
describe("BreakdownTile error-state parity (loaded, hasError)", () => {
  it("reserves the same sub-row footprint as the loaded-with-total state instead of collapsing to nothing", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} />);
    const loadedRows = getSubRows();
    expect(loadedRows).toHaveLength(3);

    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} hasError />);
    expect(getSubRows()).toHaveLength(0);
    const errorSpacerRows = getEmptyStateSpacerRows();
    expect(errorSpacerRows).toHaveLength(loadedRows.length);
  });

  it("sizes the error-state spacer slots identically to the loading/empty-state placeholders (w-14/h-3, same labels)", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} hasError />);
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

  it("hides the spacer from assistive tech and does not duplicate the error message inside the sub-row block", () => {
    render(<BreakdownTile {...BASE_PROPS} isLoading={false} hasError />);
    const spacer = container.querySelector(".invisible.flex.flex-wrap");
    expect(spacer).not.toBeNull();
    expect(spacer!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(getEmptyStateMessage()).toBeNull();

    // The error message renders once, on the subtitle line.
    expect(container.textContent).toContain("Some chains failed to load");
  });

  it("reserves the same footprint regardless of whether a total resolved before the error", () => {
    render(
      <BreakdownTile {...BASE_PROPS} isLoading={false} hasError total={null} />,
    );
    expect(getEmptyStateSpacerRows()).toHaveLength(3);
  });
});
