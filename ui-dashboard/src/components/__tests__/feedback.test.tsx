/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TableRowsSkeleton } from "@/components/feedback";

// `TableRowsSkeleton` is a drop-in alternative to `<Skeleton rows={n} />`
// that reserves a header row + real-table-shaped rows so a loading table
// doesn't collapse to less height than the table it stands in for (see
// `table.tsx` `Row`/`Td` and `global-pools-table/pool-row.tsx` `Cell` for the
// real geometry this mirrors).

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

function getSkeleton(): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '[role="status"][aria-label="Loading table"]',
  );
  if (!el) throw new Error("TableRowsSkeleton root not found");
  return el;
}

describe("TableRowsSkeleton", () => {
  it("renders one header bar plus the requested number of rows", () => {
    render(<TableRowsSkeleton rows={5} />);
    const skeleton = getSkeleton();
    const [header, body] = Array.from(skeleton.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(body.children).toHaveLength(5);
    // The header is a single full-width bar (no column split needed to be a
    // drop-in replacement for callers that only know a row count).
    expect(header.tagName).toBe("DIV");
  });

  it("reserves ~36px for the header row and ~44px per data row", () => {
    render(<TableRowsSkeleton rows={2} />);
    const skeleton = getSkeleton();
    const [header, body] = Array.from(skeleton.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(header.style.height).toBe("36px");
    Array.from(body.children).forEach((row) => {
      expect((row as HTMLElement).style.height).toBe("44px");
    });
  });

  it("handles rows=0 by rendering only the header row", () => {
    render(<TableRowsSkeleton rows={0} />);
    const skeleton = getSkeleton();
    const [, body] = Array.from(skeleton.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(body.children).toHaveLength(0);
  });

  it("advertises itself to assistive tech via role=status + aria-label", () => {
    render(<TableRowsSkeleton rows={1} />);
    const skeleton = getSkeleton();
    expect(skeleton.textContent).toContain("Loading…");
  });
});
