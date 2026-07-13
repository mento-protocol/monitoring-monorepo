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
  it("renders a heading bar, subtitle bar, and a table-shaped block (header row + one row per market)", () => {
    render(<CdpActivityDigestSkeleton />);
    const card = container.firstElementChild!;
    expect(card.className).toContain("rounded-lg");
    // heading bar + subtitle bar + table-shaped content wrapper
    expect(card.children).toHaveLength(3);
    const tableBlock = card.children[2]!;
    // thead-height header bar + one body-row bar per market
    expect(tableBlock.children).toHaveLength(4);
  });
});

describe("CdpTransactionsBodySkeleton", () => {
  it("reserves a filter bar, a table at cdps-measured geometry, and a two-line pagination footer", () => {
    render(<CdpTransactionsBodySkeleton />);
    const wrapper = container.querySelector<HTMLElement>(
      '[aria-label="Loading transactions"]',
    );
    expect(wrapper).not.toBeNull();
    // filter bar, table skeleton, footnote line, pagination-nav row
    const [, table, footnote, paginationRow] = Array.from(
      wrapper!.children,
    ) as HTMLElement[];
    expect(footnote).toBeDefined();
    expect(paginationRow).toBeDefined();

    // Composed locally (not the shared TableSkeleton) so header/row
    // heights pin the cdps-measured rhythm — 45px header, 47px rows —
    // rather than the shared component's 36/44 constants.
    const [header, body] = Array.from(table!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(header.style.height).toBe("45px");
    expect(body.children).toHaveLength(CDP_OVERVIEW_TABLE_PAGE_SIZE);
    for (const row of Array.from(body.children) as HTMLElement[]) {
      expect(row.style.height).toBe("47px");
    }
  });

  it("announces via its own live region when standalone (default)", () => {
    render(<CdpTransactionsBodySkeleton />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    // The wrapper's own region + the nested table skeleton would double up
    // unless the nested table stays presentational.
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute("aria-label")).toBe("Loading transactions");
  });

  it("suppresses its own live region when presentational (parent owns it)", () => {
    render(<CdpTransactionsBodySkeleton presentational />);
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
  });
});
