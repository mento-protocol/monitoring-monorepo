import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Render the Plot as an inert marker — the accessible name / text alternative
// live on the container the card controls, not inside Plotly's SVG.
vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot() {
      return React.createElement("div", { "data-testid": "plot" });
    },
}));

import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import type { TimeSeriesPoint } from "@/lib/time-series";

const SERIES: TimeSeriesPoint[] = [
  { timestamp: 1_000, value: 1_000_000 },
  { timestamp: 2_000, value: 2_690_000 },
];

function render(
  overrides: Partial<React.ComponentProps<typeof TimeSeriesChartCard>> = {},
): string {
  const props: React.ComponentProps<typeof TimeSeriesChartCard> = {
    title: "Total Value Locked",
    rangeAriaLabel: "TVL chart time range",
    series: SERIES,
    range: "7d",
    onRangeChange: () => {},
    headline: "$2.69M",
    change: 3.1,
    isLoading: false,
    hasError: false,
    hasSnapshotError: false,
    emptyMessage: "Not enough history yet",
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(TimeSeriesChartCard, props));
}

describe("TimeSeriesChartCard accessibility (WCAG 1.1.1)", () => {
  it("exposes the plot as role=figure with a dynamic, non-empty accessible name", () => {
    const html = render();
    // role="figure" gives the chart the aria-label as its accessible name
    // (which reflects the live range so it can't go stale) while keeping the
    // interactive Plotly controls and axis/legend text in the a11y tree.
    expect(html).toContain('role="figure"');
    expect(html).toContain('aria-label="Total Value Locked chart, 1W range"');
  });

  it("re-labels when the active range changes so the name tracks the series", () => {
    const html = render({ range: "all" });
    expect(html).toContain('aria-label="Total Value Locked chart, All range"');
  });

  it("carries a visually-hidden text alternative summarizing range + trend", () => {
    const html = render();
    expect(html).toContain("sr-only");
    // The summary describes range + trend direction, deliberately without a
    // specific value: consumers denominate their headline differently (dollar
    // totals, per-day latest, token amounts), so a single formatter here would
    // mislabel some of them.
    expect(html).toContain(
      "Total Value Locked chart over the 1W range, up 3.10% week-over-week.",
    );
  });

  it("describes a negative change as a downward trend", () => {
    const html = render({ change: -4.2 });
    expect(html).toContain("down 4.20% week-over-week");
  });

  it("summarizes the loading state instead of a stale value", () => {
    const html = render({ isLoading: true });
    expect(html).toContain('aria-label="Total Value Locked chart, 1W range"');
    expect(html).toContain("Total Value Locked chart is loading.");
  });

  it("summarizes the empty state with the empty message", () => {
    const html = render({ series: [], change: null });
    expect(html).toContain("Total Value Locked chart: Not enough history yet");
  });
});
