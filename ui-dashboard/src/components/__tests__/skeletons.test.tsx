/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ChartSkeleton,
  PageShellSkeleton,
  TableSkeleton,
  TileGridSkeleton,
} from "@/components/skeletons";

// Tests assert structural behavior (number of rows/tiles, aria annotations)
// rather than substring-matching a shimmer classname. Class-based counts
// would pass even if the JSX reorganised into something user-visibly wrong.

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

function getTableSkeleton(): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '[role="status"][aria-label="Loading table"]',
  );
  if (!el) throw new Error("TableSkeleton root not found");
  return el;
}

function getTileGridSkeleton(): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '[role="status"][aria-label="Loading metrics"]',
  );
  if (!el) throw new Error("TileGridSkeleton root not found");
  return el;
}

describe("TableSkeleton", () => {
  it("renders one header row plus the requested number of data rows", () => {
    render(<TableSkeleton rows={3} cols={4} />);
    const table = getTableSkeleton();
    const [header, body] = Array.from(table.children) as HTMLElement[];
    expect(header.children).toHaveLength(4);
    expect(body.children).toHaveLength(3);
    Array.from(body.children).forEach((row) => {
      expect(row.children).toHaveLength(4);
    });
  });

  it("uses defaults of 8 rows × 5 cols when props omitted", () => {
    render(<TableSkeleton />);
    const [header, body] = Array.from(
      getTableSkeleton().children,
    ) as HTMLElement[];
    expect(header.children).toHaveLength(5);
    expect(body.children).toHaveLength(8);
  });

  it("handles rows=0 by rendering only the header row", () => {
    render(<TableSkeleton rows={0} cols={3} />);
    const [header, body] = Array.from(
      getTableSkeleton().children,
    ) as HTMLElement[];
    expect(header.children).toHaveLength(3);
    expect(body.children).toHaveLength(0);
  });

  it("advertises itself to assistive tech via role=status + aria-live", () => {
    render(<TableSkeleton rows={1} cols={1} />);
    const table = getTableSkeleton();
    expect(table.getAttribute("aria-live")).toBe("polite");
    expect(table.textContent).toContain("Loading…");
  });
});

describe("TileGridSkeleton", () => {
  it("renders the requested tile count", () => {
    render(<TileGridSkeleton count={6} />);
    const grid = getTileGridSkeleton();
    // One screen-reader-only "Loading…" span is a sibling of the tiles; count
    // only direct div children (the tiles).
    const tiles = Array.from(grid.children).filter(
      (child) => child.tagName === "DIV",
    );
    expect(tiles).toHaveLength(6);
  });

  it("defaults to 4 tiles", () => {
    render(<TileGridSkeleton />);
    const grid = getTileGridSkeleton();
    const tiles = Array.from(grid.children).filter(
      (child) => child.tagName === "DIV",
    );
    expect(tiles).toHaveLength(4);
  });
});

describe("ChartSkeleton", () => {
  it("applies the requested aspect ratio inline", () => {
    render(<ChartSkeleton aspect="4 / 3" />);
    const chart = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading chart"]',
    );
    expect(chart?.style.aspectRatio).toBe("4 / 3");
  });

  it("defaults to 16:9 with role=status", () => {
    render(<ChartSkeleton />);
    const chart = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading chart"]',
    );
    expect(chart?.style.aspectRatio).toBe("16 / 9");
    expect(chart?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("PageShellSkeleton", () => {
  it("wraps children in a single live region", () => {
    render(<PageShellSkeleton />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute("aria-label")).toBe("Loading");
  });

  it("inner skeletons are presentational (no nested role=status)", () => {
    render(<PageShellSkeleton />);
    const wrapper = container.querySelector('[aria-live="polite"]')!;
    const nestedStatuses = wrapper.querySelectorAll('[role="status"]');
    expect(nestedStatuses).toHaveLength(0);
  });
});
