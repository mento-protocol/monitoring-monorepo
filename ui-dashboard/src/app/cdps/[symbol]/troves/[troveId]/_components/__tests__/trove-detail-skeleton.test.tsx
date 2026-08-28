/** @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TroveDetailSkeleton } from "../trove-detail-skeleton";

type Handle = { container: HTMLDivElement; root: Root };

function render(node: React.ReactElement): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

describe("TroveDetailSkeleton", () => {
  let handle: Handle | null = null;

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
      handle = null;
    }
  });

  it("reserves 7 header-stat placeholders, matching TroveHeaderStats", () => {
    handle = render(<TroveDetailSkeleton />);
    // 7 stats: owner/opened/closed-or-updated/rate/coll/debt/icr.
    const headerGrid = handle.container.querySelector(
      ".grid.grid-cols-2.gap-x-4.gap-y-4",
    );
    expect(headerGrid?.children.length).toBe(7);
  });

  it("reserves the impact card's maximum shape: 5 redemption figures plus the 3-cell liquidation block", () => {
    // TroveRedemptionImpact's reconciled mode renders 5 redemption figures
    // (count, debt repaid, collateral taken, fees kept, net equity) and can
    // additionally show the liquidation block (2 stats + the optional
    // collateral-surplus cell) for a trove partially redeemed and later
    // liquidated — reserving fewer under-counts that combined case.
    handle = render(<TroveDetailSkeleton />);
    const grids = handle.container.querySelectorAll(
      ".grid.grid-cols-2.gap-x-4.gap-y-3.sm\\:grid-cols-4",
    );
    expect(grids.length).toBe(2);
    expect(grids[0]?.children.length).toBe(5);
    expect(grids[1]?.children.length).toBe(3);
  });

  it("reserves the impact | queue two-up row matching the loaded grid", () => {
    // The loaded view renders TroveRedemptionImpact and the redemption-queue
    // panel side by side in a `lg:grid-cols-2` row — the skeleton reserves
    // both cards inside the same grid so the row splits at the same
    // breakpoint loading and loaded.
    handle = render(<TroveDetailSkeleton />);
    const grid = handle.container.querySelector(".grid.gap-6.lg\\:grid-cols-2");
    expect(grid).not.toBeNull();
    expect(grid?.children.length).toBe(2);
  });

  it("reserves the chart card between the two-up row and the history block", () => {
    // The loaded view mounts TroveBalanceChart (complete-ledger mode) in
    // this slot with a fixed 380px plot area — the skeleton reserves the
    // same card so the ledger section doesn't jump up and back down while
    // data resolves.
    handle = render(<TroveDetailSkeleton />);
    const grid = handle.container.querySelector(".grid.gap-6.lg\\:grid-cols-2");
    const chartCard = grid?.nextElementSibling;
    expect(chartCard?.className).toContain("rounded-lg");
    const plotArea = chartCard?.querySelector<HTMLElement>('[style*="height"]');
    expect(plotArea?.style.height).toBe("380px");
  });

  it("renders the operations section as a table-shaped skeleton, not generic bars", () => {
    // Route-level fallback must match TroveOperationsList's own loading
    // branch (TableSkeleton) — a Playwright/table element or the fixed
    // header-row height is evidence of the table-shaped structure, not a
    // pile of undifferentiated `h-10` bars.
    handle = render(<TroveDetailSkeleton />);
    const text = handle.container.textContent ?? "";
    expect(text).not.toContain("Trove operations");
    const statusRegions = handle.container.querySelectorAll('[role="status"]');
    // Exactly one live region for the whole trailing block — TableSkeleton
    // renders `presentational` so it doesn't add a second, nested one.
    expect(statusRegions.length).toBe(1);
    expect(statusRegions[0]?.getAttribute("aria-label")).toBe("Loading trove");
  });

  it("renders without throwing and keeps a single top-level live region", () => {
    handle = render(<TroveDetailSkeleton />);
    expect(
      handle.container.querySelectorAll('[aria-live="polite"]').length,
    ).toBe(1);
  });
});
