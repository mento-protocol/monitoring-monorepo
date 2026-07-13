/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CDP_OVERVIEW_TABLE_PAGE_SIZE } from "../../_lib/transactions";
import {
  CdpActivityDigestSkeleton,
  CdpMarketCardGridSkeleton,
  CdpTransactionsBodySkeleton,
} from "../cdps-skeletons";

// Tests assert structural behavior (child counts, aria annotations) rather
// than substring-matching a shimmer classname — see the same rationale in
// src/components/__tests__/skeletons.test.tsx.

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

describe("CdpMarketCardGridSkeleton", () => {
  it("mirrors the loaded market grid: 3 cards, each with a 2x2 metric grid", () => {
    render(<CdpMarketCardGridSkeleton />);
    const grid = container.firstElementChild!;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("md:grid-cols-3");
    expect(grid.children).toHaveLength(3);

    for (const card of Array.from(grid.children)) {
      const metricGrid = card.querySelector(".grid-cols-2");
      expect(metricGrid).not.toBeNull();
      expect(metricGrid!.children).toHaveLength(4);
    }
  });
});

describe("CdpActivityDigestSkeleton", () => {
  it("renders a heading bar, subtitle bar, and per-market content rows", () => {
    render(<CdpActivityDigestSkeleton />);
    const card = container.firstElementChild!;
    expect(card.className).toContain("rounded-lg");
    // heading bar + subtitle bar + one content-row wrapper
    expect(card.children).toHaveLength(3);
    const rows = card.children[2]!;
    expect(rows.children).toHaveLength(3);
  });
});

describe("CdpTransactionsBodySkeleton", () => {
  it("reserves a filter bar, one page of rows, and a pagination-footer bar", () => {
    render(<CdpTransactionsBodySkeleton />);
    const wrapper = container.querySelector<HTMLElement>(
      '[aria-label="Loading transactions"]',
    );
    expect(wrapper).not.toBeNull();
    // filter bar, table skeleton, pagination-footer placeholder
    const [, table, footer] = Array.from(wrapper!.children) as HTMLElement[];
    expect(footer).toBeDefined();
    // The nested TableSkeleton stays presentational (no role/aria-live of
    // its own) so it doesn't double up with the wrapper's live region, but
    // its header+body structure is unchanged.
    const [, body] = Array.from(table!.children) as [HTMLElement, HTMLElement];
    expect(body.children).toHaveLength(CDP_OVERVIEW_TABLE_PAGE_SIZE);
  });

  it("announces via its own live region when standalone (default)", () => {
    render(<CdpTransactionsBodySkeleton />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    // The wrapper's own region + the nested TableSkeleton would double up
    // unless the nested table stays presentational.
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute("aria-label")).toBe("Loading transactions");
  });

  it("suppresses its own live region when presentational (parent owns it)", () => {
    render(<CdpTransactionsBodySkeleton presentational />);
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
  });
});
