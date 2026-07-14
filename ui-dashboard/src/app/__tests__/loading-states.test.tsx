/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RootLoading from "@/app/loading";
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
  it("RootLoading renders exactly one polite live region (PageShellSkeleton wrapper)", () => {
    render(<RootLoading />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
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

  it("VolumeLoading reserves a 3-panel flow-insights grid mirroring V3FlowInsights", () => {
    render(<VolumeLoading />);

    const grid = container.querySelector(".xl\\:grid-cols-3");
    expect(grid).not.toBeNull();
    expect(grid!.children).toHaveLength(3);
  });

  it("VolumeLoading only fixes flow-insight panel height at the xl breakpoint where the grid goes 3-column", () => {
    render(<VolumeLoading />);

    // The grid stacks to a single column below `xl` (mirroring
    // V3FlowInsights' `grid-cols-1 xl:grid-cols-3`) — below `xl` each panel
    // is a full-width row on its own, not a column sharing a row's height
    // with the taller corridor/outlier panels. A desktop-measured 500px
    // fixed height would triple-reserve ~1500px on narrow viewports (the
    // real cohort panel is much shorter), so the panels must use a
    // breakpoint-scoped class rather than an unconditional inline style.
    const grid = container.querySelector(".xl\\:grid-cols-3");
    expect(grid).not.toBeNull();
    Array.from(grid!.children).forEach((panel) => {
      expect((panel as HTMLElement).style.height).toBe("");
      expect(panel.className).toContain("xl:h-[500px]");
    });
  });

  it("VolumeLoading reserves a single full-width top-traders table, not a two-column layout", () => {
    render(<VolumeLoading />);

    // Table-shaped skeletons (header 36px bar + 44px measured rows) reserve
    // exactly two: the top-traders table and the aggregator table. Neither
    // reserves a side column — `TopPoolsList` only renders alongside the
    // per-pool chart for the 30d/90d/all ranges, which this route's default
    // 7d fallback never reaches. `TableSkeleton` is rendered `presentational`
    // here (a single outer live region already wraps the whole page), which
    // strips its own `aria-label` — so table-skeleton roots are located
    // structurally via the 36px header bar instead.
    const tableSkeletonRoots = Array.from(
      container.querySelectorAll<HTMLElement>("div"),
    ).filter(
      (el) =>
        (el.firstElementChild as HTMLElement | null)?.style.height === "36px",
    );
    expect(tableSkeletonRoots).toHaveLength(2);
  });

  it("VolumeLoading reserves the full aggregator chart card chrome (title/headline/range pills), not a bare 230px box, ahead of the table skeleton", () => {
    render(<VolumeLoading />);

    const plotPlaceholders = [
      ...container.querySelectorAll<HTMLElement>("[class*='h-[230px]']"),
    ];
    expect(plotPlaceholders).toHaveLength(1);
    const [plot] = plotPlaceholders;

    // The 230px plot must sit inside the same full card chrome as the hero
    // chart card above it — p-5/sm:p-6 rounded card wrapping a title line,
    // a 3xl/4xl headline, and a 4-pill range group — not stand alone as the
    // entire "card".
    const card = plot!.closest("section.rounded-lg");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".text-3xl")).not.toBeNull();
    const rangePills = card!.querySelectorAll(".h-6.w-9");
    expect(rangePills).toHaveLength(4);

    // AggregatorBreakdownSection passes yAxisTopPadding={0} to this card,
    // which triggers TimeSeriesChartCard's dense-layout bottom-padding
    // override — mirrored here so the card doesn't shrink on client mount.
    expect(card!.className).toContain("pb-2");
    expect(card!.className).toContain("sm:pb-3");
  });

  it("VolumeLoading reserves a second line under the aggregator heading for its static description paragraph", () => {
    render(<VolumeLoading />);

    // AggregatorBreakdownSection always renders a title plus a
    // `mt-1 text-xs` description paragraph underneath it — a single 16px
    // heading bar undershoots that block by ~25px on client mount.
    const heading = container.querySelector<HTMLElement>(".h-4.w-64");
    expect(heading).not.toBeNull();
    const descriptionLine = heading!.nextElementSibling as HTMLElement | null;
    expect(descriptionLine).not.toBeNull();
    expect(descriptionLine!.className).toContain("mt-1");
    expect(descriptionLine!.className).toContain("h-3");
  });
});
