/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/time-series-chart-card", () => ({
  TimeSeriesChartCard: () => <div data-testid="chart" />,
}));

// V3FlowInsights runs its own SWR queries (and its panel skeletons are
// role="status" without explicit aria-live) — out of scope for the
// table-skeleton live-region invariant under test here.
vi.mock("../v3-flow-insights", () => ({
  V3FlowInsights: () => null,
}));

import { V3VolumeSection } from "../v3-volume-section";

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

function renderSection({
  tableIsLoading,
  aggregatorIsLoading,
}: {
  tableIsLoading: boolean;
  aggregatorIsLoading: boolean;
}) {
  act(() => {
    root.render(
      <V3VolumeSection
        rangeLabel="7d"
        aggregatorRangeLabel="7d"
        range="7d"
        cutoff={0}
        filteredTraderRows={[]}
        traders={[]}
        pools={new Map()}
        chainIdIn={[42220, 143, 137]}
        protocolActorFilter={[false]}
        canUseVolumeFilters={false}
        tableState={{
          isLoading: tableIsLoading,
          hasError: false,
          isCapHit: false,
        }}
        aggregators={[]}
        aggregatorState={{
          isLoading: aggregatorIsLoading,
          hasError: false,
          isCapHit: false,
        }}
      />,
    );
  });
}

function tableSkeletonRoots(): HTMLElement[] {
  // A 36px header bar identifies each `TableSkeleton variant="rows"` root,
  // presentational or not.
  return Array.from(container.querySelectorAll<HTMLElement>("div")).filter(
    (el) =>
      (el.firstElementChild as HTMLElement | null)?.style.height === "36px",
  );
}

// The top-traders table (volume-table.tsx) and the aggregator breakdown
// table (aggregator-breakdown-section.tsx) are backed by independent SWR
// queries and commonly load simultaneously on first mount. Each renders a
// `TableSkeleton`, which is a polite live region by default. The venue
// section wires the trader table's loading state into the aggregator
// section's `hasExternalLoadingAnnouncer` so the page has exactly one
// announcer in every combination — never two competing live regions during
// combined loading, and never zero while something is still loading.
describe("/volume client-side loading — single live region invariant", () => {
  it("renders exactly one aria-live=polite region when both tables load simultaneously", () => {
    renderSection({ tableIsLoading: true, aggregatorIsLoading: true });

    // Both table skeletons render — the wiring silences one, it doesn't
    // remove it.
    expect(tableSkeletonRoots()).toHaveLength(2);

    // Exactly one live region: the presentational aggregator skeleton
    // strips `role`/`aria-live`/`aria-label` entirely, so the surviving
    // `role="status"` element and the surviving `aria-live="polite"`
    // element must be the same node (the top-traders table).
    const statusRegions = container.querySelectorAll('[role="status"]');
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(statusRegions).toHaveLength(1);
    expect(liveRegions).toHaveLength(1);
    expect(statusRegions[0]).toBe(liveRegions[0]);
    expect(liveRegions[0]?.getAttribute("aria-label")).toBe("Loading table");
  });

  it("keeps a standalone-loading aggregator table announced once the trader table settles", () => {
    renderSection({ tableIsLoading: false, aggregatorIsLoading: true });

    // Only the aggregator skeleton remains (the trader table settled into
    // its empty state) — it must announce itself now that nothing else on
    // the page covers the loading state (codex review, PR 1242).
    expect(tableSkeletonRoots()).toHaveLength(1);
    const statusRegions = container.querySelectorAll('[role="status"]');
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(statusRegions).toHaveLength(1);
    expect(liveRegions).toHaveLength(1);
    expect(statusRegions[0]).toBe(liveRegions[0]);
    expect(liveRegions[0]?.getAttribute("aria-label")).toBe("Loading table");
  });
});
