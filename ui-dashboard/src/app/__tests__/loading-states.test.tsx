/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RootLoading from "@/app/loading";
import PoolsLoading from "@/app/pools/loading";
import PoolDetailLoading from "@/app/pool/[poolId]/loading";
import AddressBookLoading from "@/app/address-book/loading";
import VolumeLoading from "@/app/volume/loading";
import { ROW_CHART_HEIGHT_PX } from "@/lib/plot";

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
    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
  });

  it("RootLoading nests only presentational primitives (no nested role=status under the page live region)", () => {
    render(<RootLoading />);
    const wrapper = container.querySelector('[aria-live="polite"]')!;
    expect(wrapper.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("RootLoading reserves two chart cards (TVL + Volume) — absent entirely from the old generic PageShellSkeleton", () => {
    render(<RootLoading />);
    const chartsRow = container.querySelector(".lg\\:grid-cols-2");
    expect(chartsRow).not.toBeNull();
    expect(chartsRow!.children).toHaveLength(2);

    // Chart plot areas reserve ROW_CHART_HEIGHT_PX, matched on the shared
    // constant so a future height change can't silently strand this at a
    // stale hardcoded value.
    const plotAreas = [...container.querySelectorAll("[style]")].filter(
      (el) => (el as HTMLElement).style.height === `${ROW_CHART_HEIGHT_PX}px`,
    );
    expect(plotAreas).toHaveLength(2);

    // Both homepage charts (TvlOverTimeChart, VolumeOverTimeChart) omit
    // `reserveDeltaRow`, so both default to `true` — unlike the pool-detail
    // volume card, both skeleton cards reserve the delta placeholder.
    Array.from(chartsRow!.children).forEach((card) => {
      expect((card as HTMLElement).querySelector(".h-5.w-32")).not.toBeNull();
    });
  });

  it("RootLoading reserves a 4-tile KPI row (Swap Fees / LPs / Swaps / Traders)", () => {
    render(<RootLoading />);
    const kpiRow = container.querySelector(".lg\\:grid-cols-4");
    expect(kpiRow).not.toBeNull();
    const tiles = Array.from(kpiRow!.children).filter(
      (child) => child.tagName === "DIV",
    );
    expect(tiles).toHaveLength(4);
  });

  // Swap Fees (BreakdownTile) is the tallest KPI cell — label + value +
  // 24h/7d/30d subrow + subtitle line, ~140px — and CSS Grid's default
  // row-stretch means it (not the shorter LPs/Swaps/Traders `Tile` shape)
  // sets the row's real height. Every placeholder must mirror that taller
  // shape, not a compact generic tile.
  it("RootLoading KPI tiles mirror BreakdownTile's geometry (subrow + subtitle line)", () => {
    render(<RootLoading />);
    const kpiRow = container.querySelector(".lg\\:grid-cols-4")!;
    Array.from(kpiRow.children).forEach((tile) => {
      const subrow = tile.querySelector(".mt-1\\.5");
      expect(subrow).not.toBeNull();
      expect(subrow!.children).toHaveLength(3);
      expect(tile.querySelector(".mt-2")).not.toBeNull();
    });
  });

  it("RootLoading reserves a table-shaped pools placeholder (header ~36px, rows ~44px)", () => {
    render(<RootLoading />);
    const table = container.querySelector(".overflow-hidden.rounded-lg");
    expect(table).not.toBeNull();
    const [header, body] = Array.from(table!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(header.style.height).toBe("36px");
    expect(body.children).toHaveLength(10);
    Array.from(body.children).forEach((row) => {
      expect((row as HTMLElement).style.height).toBe("44px");
    });
  });

  it("PoolsLoading renders exactly one polite live region", () => {
    render(<PoolsLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("PoolsLoading nests only presentational primitives (no nested role=status under the page live region)", () => {
    render(<PoolsLoading />);
    const wrapper = container.querySelector('[aria-live="polite"]')!;
    expect(wrapper.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("PoolsLoading reserves a 3-tile KPI row (Pools / Showing / Latest Swap Block)", () => {
    render(<PoolsLoading />);
    const kpiRow = container.querySelector(".sm\\:grid-cols-3");
    expect(kpiRow).not.toBeNull();
    expect(kpiRow!.children).toHaveLength(3);
  });

  it("PoolsLoading reserves table-shaped pools and Recent Swaps sections (header ~36px, rows ~44px)", () => {
    render(<PoolsLoading />);
    const tables = container.querySelectorAll(".overflow-hidden.rounded-lg");
    expect(tables).toHaveLength(2);

    const [poolsTable, swapsTable] = Array.from(tables) as HTMLElement[];

    const [poolsHeader, poolsBody] = Array.from(poolsTable!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(poolsHeader.style.height).toBe("36px");
    expect(poolsBody.children).toHaveLength(10);

    const [swapsHeader, swapsBody] = Array.from(swapsTable!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(swapsHeader.style.height).toBe("36px");
    // Reserves the default page size (25) — the route loading UI can't read
    // the `?limit=` URL param, unlike `pools-page-client.tsx`'s own
    // swaps-loading skeleton, which sizes to the live `limit` value.
    expect(swapsBody.children).toHaveLength(25);
  });

  it("PoolDetailLoading renders exactly one polite live region (on TableSkeleton)", () => {
    render(<PoolDetailLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("AddressBookLoading renders exactly one polite live region (on TableSkeleton)", () => {
    render(<AddressBookLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("AddressBookLoading skeleton matches the real table shape (10 cols)", () => {
    render(<AddressBookLoading />);
    const table = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading table"]',
    );
    expect(table).not.toBeNull();
    const [header] = Array.from(table!.children) as HTMLElement[];
    expect(header!.children).toHaveLength(10);
  });

  it("PoolDetailLoading skeleton matches the real page shape (7 tabs, 6-col table)", () => {
    render(<PoolDetailLoading />);
    const table = container.querySelector<HTMLElement>(
      '[role="status"][aria-label="Loading table"]',
    );
    expect(table).not.toBeNull();
    const [header] = Array.from(table!.children) as HTMLElement[];
    expect(header!.children).toHaveLength(6);

    // Tab strip: 7 placeholder bars inside a flex container with a bottom border
    const tabStrip = container.querySelector(".flex.gap-1.border-b");
    expect(tabStrip).not.toBeNull();
    expect(tabStrip!.children).toHaveLength(7);
  });

  it("PoolDetailLoading reserves the header card, health bar, and charts row (CLS guard)", () => {
    render(<PoolDetailLoading />);

    // Header card: 5-col stat grid mirroring PoolHeader's <dl>.
    const statGrid = container.querySelector(".lg\\:grid-cols-5");
    expect(statGrid).not.toBeNull();
    expect(statGrid!.children).toHaveLength(5);

    // Charts row: two chart cards + reserves panel, mirroring PoolChartsRow.
    const chartsRow = container.querySelector(".lg\\:grid-cols-3");
    expect(chartsRow).not.toBeNull();
    expect(chartsRow!.children).toHaveLength(3);

    // Chart card plot areas reserve ROW_CHART_HEIGHT_PX so the real
    // TimeSeriesChartCards stream in without pushing the tab strip down.
    // Matched on the inline style derived from the shared constant, so a
    // future height change can't silently strand the skeleton at a stale
    // hardcoded value.
    const plotAreas = [...container.querySelectorAll("[style]")].filter(
      (el) => (el as HTMLElement).style.height === `${ROW_CHART_HEIGHT_PX}px`,
    );
    expect(plotAreas).toHaveLength(2);
  });

  it("PoolDetailLoading reserves the delta row only on the TVL chart skeleton (delta-row parity)", () => {
    render(<PoolDetailLoading />);

    const chartsRow = container.querySelector(".lg\\:grid-cols-3");
    expect(chartsRow).not.toBeNull();
    const [tvlCard, volumeCard] = Array.from(
      chartsRow!.children,
    ) as HTMLElement[];

    // The delta placeholder is the `h-5 w-32` shimmer bar. PoolTvlOverTimeChart
    // (first card) can render a real week-over-week delta, so its skeleton
    // reserves the row; PoolVolumeOverTimeChart (second card) passes
    // change={null} + reserveDeltaRow={false} and never shows one, so its
    // skeleton must not reserve it — otherwise the volume skeleton stands ~20px
    // taller than the card that streams in.
    expect(tvlCard!.querySelector(".h-5.w-32")).not.toBeNull();
    expect(volumeCard!.querySelector(".h-5.w-32")).toBeNull();
  });

  it("VolumeLoading renders exactly one polite live region", () => {
    render(<VolumeLoading />);
    expect(countLiveRegions()).toBe(1);
  });

  it("VolumeLoading chart-card skeleton reserves no delta row (matches DailyVolumeChart reserveDeltaRow={false})", () => {
    render(<VolumeLoading />);

    // The DailyVolumeChart fallback the route reserves for the common 7d/v3
    // case passes reserveDeltaRow={false} and never renders a delta line, so
    // the route skeleton must not reserve the `flex h-5 items-center` delta
    // wrapper — reserving it shifted the KPI tiles down ~20px on swap.
    expect(container.querySelector(".flex.h-5.items-center")).toBeNull();
  });
});
