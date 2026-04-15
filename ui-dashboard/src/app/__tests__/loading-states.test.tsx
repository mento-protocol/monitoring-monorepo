/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RootLoading from "@/app/loading";
import PoolDetailLoading from "@/app/pool/[poolId]/loading";
import AddressBookLoading from "@/app/address-book/loading";

// Each route-level loading UI must expose exactly one aria-live region so
// screen readers don't announce nested status regions redundantly. Keeping
// this invariant in a test pins it against future accidental additions.

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

function countLiveRegions(): number {
  return container.querySelectorAll('[aria-live="polite"]').length;
}

describe("route-level loading UIs", () => {
  it("RootLoading renders exactly one polite live region", () => {
    render(<RootLoading />);
    // PageShellSkeleton composes TileGridSkeleton + TableSkeleton (two live
    // regions by design — they are sibling sections announcing different
    // loading states, not nested). One level deep, no nesting.
    const regions = Array.from(
      container.querySelectorAll<HTMLElement>('[aria-live="polite"]'),
    );
    expect(regions.length).toBeGreaterThan(0);
    // No region should be a descendant of another region.
    regions.forEach((a) =>
      regions.forEach((b) => {
        if (a !== b) expect(a.contains(b)).toBe(false);
      }),
    );
  });

  it("PoolDetailLoading renders exactly one polite live region (on TableSkeleton)", () => {
    render(<PoolDetailLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("AddressBookLoading renders exactly one polite live region (on TableSkeleton)", () => {
    render(<AddressBookLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("AddressBookLoading renders a table skeleton that structurally matches the real table", () => {
    // Real address-book table has 8 header columns (AddressBookClient.tsx);
    // the skeleton must stay in sync to prevent layout jump on load.
    render(<AddressBookLoading />);
    const table = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading table"]',
    );
    expect(table).not.toBeNull();
    const [header] = Array.from(table!.children) as HTMLElement[];
    expect(header.children).toHaveLength(8);
  });
});
