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

import { VolumeTable } from "../volume-table";
import { AggregatorBreakdownSection } from "../aggregator-breakdown-section";

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

describe("/volume client-side loading — single live region invariant", () => {
  // The top-traders table (volume-table.tsx) and the aggregator breakdown
  // table (aggregator-breakdown-section.tsx) are backed by independent SWR
  // queries in V3VolumeSection/V2VolumeSection and commonly load
  // simultaneously on first mount. Each renders a `TableSkeleton`, which is
  // a polite live region by default — without exactly one of them opting
  // out via `presentational`, screen readers get two competing "Loading
  // table" announcements at once.
  it("renders exactly one aria-live=polite region when both tables load simultaneously", () => {
    render(
      <>
        <VolumeTable
          cutoff={0}
          traders={[]}
          pools={new Map()}
          emptyMessage="No traders."
          isLoading
          hasError={false}
        />
        <AggregatorBreakdownSection
          venueLabel="v3"
          rangeLabel="7d"
          aggregators={[]}
          isLoading
          hasError={false}
          isCapHit={false}
        />
      </>,
    );

    // Both table skeletons still render (a 36px header bar identifies each
    // `TableSkeleton` root) — the fix silences one of them, it doesn't
    // remove it.
    const headerBars = Array.from(
      container.querySelectorAll<HTMLElement>("div"),
    ).filter(
      (el) =>
        (el.firstElementChild as HTMLElement | null)?.style.height === "36px",
    );
    expect(headerBars).toHaveLength(2);

    // Exactly one live region — the presentational aggregator skeleton
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
});
