/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RootLoading from "@/app/loading";
import HomeLoading from "@/app/(home)/loading";
import PoolsLoading from "@/app/pools/loading";
import PoolDetailLoading from "@/app/pool/[poolId]/loading";
import AddressBookLoading from "@/app/address-book/loading";
import VolumeLoading from "@/app/volume/loading";
import { ROW_CHART_HEIGHT_PX } from "@/lib/plot";
import { POOLS_TABLE_SKELETON_ROWS } from "@/components/pools-table-skeleton";

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
  // The shared root boundary stays generic: the homepage-shaped skeleton
  // lives in `(home)/loading.tsx` (tested below), so `app/loading.tsx` renders
  // the plain PageShellSkeleton every non-homepage route inherits. This pins
  // it against accidentally re-homepage-shaping the shared boundary.
  it("RootLoading renders exactly one polite live region (PageShellSkeleton wrapper)", () => {
    render(<RootLoading />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
  });

  // The homepage-specific marker is the two-chart `lg:grid-cols-2` row, which
  // the generic PageShellSkeleton never renders (its tile grid is
  // `lg:grid-cols-4`). Asserting the chart row is absent proves the shared
  // boundary didn't inherit the homepage shape.
  it("RootLoading stays generic — no homepage chart-grid shape leaks to shared boundary", () => {
    render(<RootLoading />);
    expect(container.querySelector(".lg\\:grid-cols-2")).toBeNull();
  });

  it("HomeLoading renders exactly one polite live region", () => {
    render(<HomeLoading />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
  });

  it("HomeLoading nests only presentational primitives (no nested role=status under the page live region)", () => {
    render(<HomeLoading />);
    const wrapper = container.querySelector('[aria-live="polite"]')!;
    expect(wrapper.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("HomeLoading reserves two chart cards (TVL + Volume) — absent entirely from the old generic PageShellSkeleton", () => {
    render(<HomeLoading />);
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

  it("HomeLoading reserves a 4-tile KPI row (Swap Fees / LPs / Swaps / Traders)", () => {
    render(<HomeLoading />);
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
  it("HomeLoading KPI tiles mirror BreakdownTile's geometry (subrow + subtitle line)", () => {
    render(<HomeLoading />);
    const kpiRow = container.querySelector(".lg\\:grid-cols-4")!;
    Array.from(kpiRow.children).forEach((tile) => {
      const subrow = tile.querySelector(".mt-1\\.5");
      expect(subrow).not.toBeNull();
      expect(subrow!.children).toHaveLength(3);
      expect(tile.querySelector(".mt-2")).not.toBeNull();
    });
  });

  it("HomeLoading reserves a table-shaped pools placeholder matching PoolsTableSkeleton (header 45px, rows 58px)", () => {
    render(<HomeLoading />);
    const table = container.querySelector(".overflow-hidden.rounded-lg");
    expect(table).not.toBeNull();
    const [header, body] = Array.from(table!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(header.style.height).toBe("45px");
    expect(body.children).toHaveLength(POOLS_TABLE_SKELETON_ROWS);
    Array.from(body.children).forEach((row) => {
      expect((row as HTMLElement).style.height).toBe("58px");
    });
  });

  it("HomeLoading reserves the homepage pool-filter toolbar", () => {
    render(<HomeLoading />);
    expect(container.querySelector(".h-\\[100px\\]")).not.toBeNull();
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

  it("PoolsLoading reserves table-shaped pools (header 45px, rows 58px) and Recent Swaps (header 45px, rows 37px) sections", () => {
    render(<PoolsLoading />);
    const tables = container.querySelectorAll(".overflow-hidden.rounded-lg");
    expect(tables).toHaveLength(2);

    const [poolsTable, swapsTable] = Array.from(tables) as HTMLElement[];

    // Pools table: local rhythm (45px header, 58px rows) — the pools
    // table's real rows run taller than the shared TableSkeleton's 44px
    // because TvlCell stacks a value line + WoW sub-line. 27 rows
    // (POOLS_TABLE_SKELETON_ROWS) approximates the live pool count.
    const [poolsHeader, poolsBody] = Array.from(poolsTable!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(poolsHeader.style.height).toBe("45px");
    expect(poolsBody.children).toHaveLength(POOLS_TABLE_SKELETON_ROWS);
    Array.from(poolsBody.children).forEach((row) => {
      expect((row as HTMLElement).style.height).toBe("58px");
    });

    // Recent Swaps table: local rhythm (45px header, 37px rows) — shorter
    // than the shared TableSkeleton's 44px since every SwapTable cell is
    // single-line. Reserves the default page size (25) — the route loading
    // UI can't read the `?limit=` URL param, unlike `pools-page-client.tsx`'s
    // own swaps-loading skeleton, which sizes to the live `limit` value.
    const [swapsHeader, swapsBody] = Array.from(swapsTable!.children) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(swapsHeader.style.height).toBe("45px");
    expect(swapsBody.children).toHaveLength(25);
    Array.from(swapsBody.children).forEach((row) => {
      expect((row as HTMLElement).style.height).toBe("37px");
    });
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

  it("VolumeLoading renders the client's own flow-insight loading composition (no hand-mirrored heights)", () => {
    render(<VolumeLoading />);

    // The fallback imports InsightPanel + CohortPanelSkeleton +
    // InsightTableSkeleton from v3-flow-insight-skeletons.tsx — the same
    // components V3FlowInsights' panels render while loading — instead of
    // hand-mirroring measured heights. That keeps the fallback→client
    // handoff structurally identical at every breakpoint: a fixed desktop
    // height over-reserved when the grid stacks below xl, and no
    // reservation under-reserved against the client's intrinsic-height
    // table skeletons (both flagged by codex on this PR).
    const grid = container.querySelector(".xl\\:grid-cols-3");
    expect(grid).not.toBeNull();
    const panels = Array.from(grid!.children) as HTMLElement[];
    expect(panels).toHaveLength(3);
    panels.forEach((panel) => {
      // No fixed heights — parity comes from shared structure.
      expect(panel.style.height).toBe("");
      expect(panel.className).not.toContain("h-[500px]");
      // Real InsightPanel chrome (h3 title), not a shimmer bar.
      expect(panel.querySelector("h3")).not.toBeNull();
    });

    const [cohort, corridor, outlier] = panels;
    // Cohort: 3-stat mini grid + 3 leader rows (CohortPanelSkeleton).
    const cohortStatGrid = cohort!.querySelector(".grid-cols-3");
    expect(cohortStatGrid).not.toBeNull();
    expect(cohortStatGrid!.children).toHaveLength(3);
    // Corridor/outlier: InsightTableSkeleton with the query cap's 10 rows
    // and the real tables' column counts (4-col corridor, 3-col outlier).
    for (const [panel, cols] of [
      [corridor!, 4],
      [outlier!, 3],
    ] as const) {
      const header = panel.querySelector(".flex.gap-3.border-b");
      expect(header).not.toBeNull();
      expect(header!.children).toHaveLength(cols);
      const body = panel.querySelector(".divide-y");
      expect(body).not.toBeNull();
      expect(body!.children).toHaveLength(10);
    }
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
