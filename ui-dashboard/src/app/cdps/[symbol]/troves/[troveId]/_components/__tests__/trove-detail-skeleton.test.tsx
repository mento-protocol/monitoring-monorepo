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
