import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Render the Plot as an inert marker, matching
// `time-series-chart-card.a11y.test.tsx` — the loading branches under test
// here don't touch Plotly at all.
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
    title: "Daily traded volume",
    rangeAriaLabel: "Chart range",
    series: SERIES,
    range: "7d",
    onRangeChange: () => {},
    headline: "$3.69M",
    change: null,
    isLoading: false,
    hasError: false,
    hasSnapshotError: false,
    emptyMessage: "No volume in this window.",
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(TimeSeriesChartCard, props));
}

// The delta sub-line wrapper is `mt-1 flex h-5 items-center ...`.
const DELTA_ROW_MARKER = "flex h-5 items-center";

describe("TimeSeriesChartCard delta-row loading parity", () => {
  it("reserves the delta row while loading by default (reserveDeltaRow defaults true)", () => {
    const html = render({ isLoading: true });
    expect(html).toContain(DELTA_ROW_MARKER);
    // Placeholder matches a ~20px text line box, not a 12px pill.
    expect(html).toContain("h-5 w-16");
  });

  it("does not reserve the delta row while loading when reserveDeltaRow is false", () => {
    const html = render({ isLoading: true, reserveDeltaRow: false });
    expect(html).not.toContain(DELTA_ROW_MARKER);
  });

  it("matches loading-vs-loaded row absence for a card that always passes change=null with reserveDeltaRow=false", () => {
    const loadingHtml = render({ isLoading: true, reserveDeltaRow: false });
    const loadedHtml = render({ isLoading: false, reserveDeltaRow: false });
    expect(loadingHtml).not.toContain(DELTA_ROW_MARKER);
    expect(loadedHtml).not.toContain(DELTA_ROW_MARKER);
  });

  it("still shows the delta row once loaded on error, even with reserveDeltaRow=false", () => {
    const html = render({
      isLoading: false,
      reserveDeltaRow: false,
      hasError: true,
    });
    expect(html).toContain(DELTA_ROW_MARKER);
    expect(html).toContain("partial data");
  });

  it("renders the real delta line once loaded with a change value", () => {
    const html = render({ isLoading: false, change: 3.1 });
    expect(html).toContain(DELTA_ROW_MARKER);
    expect(html).toContain("+3.10%");
  });
});
