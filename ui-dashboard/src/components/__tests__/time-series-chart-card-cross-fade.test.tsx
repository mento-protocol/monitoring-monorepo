/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockTrace = { visible?: string };

type MockPlotProps = {
  ariaHidden?: boolean;
  data?: MockTrace[];
  onLegendClick?: (event: { readonly curveNumber: number }) => boolean;
  onHover?: (event: {
    points?: unknown[];
    event?: { clientX?: number; clientY?: number };
  }) => void;
};

const plotMock = vi.hoisted(() => ({
  MockPlot(props: MockPlotProps) {
    const visibility = (props.data ?? [])
      .map((trace) => trace.visible ?? "visible")
      .join(",");
    return (
      <div
        data-testid="plot"
        data-active={String(props.ariaHidden !== true)}
        data-visibility={visibility}
      >
        {(props.data ?? []).map((_trace, curveNumber) => (
          <button
            key={curveNumber}
            type="button"
            data-legend-curve={curveNumber}
            onClick={() => props.onLegendClick?.({ curveNumber })}
          >
            toggle {curveNumber}
          </button>
        ))}
        <button
          type="button"
          data-hover-first
          onClick={() =>
            props.onHover?.({
              points: [
                {
                  x: "2026-01-01T00:00:00.000Z",
                  curveNumber: 0,
                  pointIndex: 0,
                },
              ],
              event: { clientX: 10, clientY: 10 },
            })
          }
        >
          hover
        </button>
      </div>
    );
  },
}));

vi.mock("next/dynamic", () => ({
  default: () => plotMock.MockPlot,
}));

import { TimeSeriesChartCard } from "@/components/time-series-chart-card";
import type { BreakdownSeries } from "@/components/time-series-chart-card-overlays";

const SERIES = [
  { timestamp: 1_767_225_600, value: 30 },
  { timestamp: 1_767_312_000, value: 45 },
];

const BREAKDOWN: BreakdownSeries[] = [
  {
    id: "series-a",
    name: "Series A",
    color: "#6366f1",
    series: [
      { timestamp: SERIES[0]!.timestamp, value: 10 },
      { timestamp: SERIES[1]!.timestamp, value: 15 },
    ],
  },
  {
    id: "series-b",
    name: "Series B",
    color: "#10b981",
    series: [
      { timestamp: SERIES[0]!.timestamp, value: 20 },
      { timestamp: SERIES[1]!.timestamp, value: 30 },
    ],
  },
];

function Card({ customSortedHover = false }: { customSortedHover?: boolean }) {
  return (
    <TimeSeriesChartCard
      title="Stacked volume"
      rangeAriaLabel="Stacked volume range"
      series={SERIES}
      breakdown={BREAKDOWN}
      breakdownMode="stacked"
      range="30d"
      onRangeChange={() => undefined}
      headline="$45"
      change={null}
      isLoading={false}
      hasError={false}
      hasSnapshotError={false}
      emptyMessage="No volume"
      customSortedHover={customSortedHover}
    />
  );
}

function plots(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-testid=plot]"),
  );
}

function activePlot(container: HTMLElement): HTMLElement {
  const plot = container.querySelector<HTMLElement>(
    '[data-testid="plot"][data-active="true"]',
  );
  if (!plot) throw new Error("Expected one active Plot");
  return plot;
}

function inactivePlot(container: HTMLElement): HTMLElement {
  const plot = container.querySelector<HTMLElement>(
    '[data-testid="plot"][data-active="false"]',
  );
  if (!plot) throw new Error("Expected one inactive Plot");
  return plot;
}

function clickLegend(container: HTMLElement, curveNumber: number): void {
  const button = activePlot(container).querySelector<HTMLButtonElement>(
    `[data-legend-curve="${curveNumber}"]`,
  );
  if (!button) throw new Error(`Expected legend button ${curveNumber}`);
  act(() => button.click());
}

function layerFor(plot: HTMLElement): HTMLDivElement {
  const layer = plot.parentElement;
  if (!(layer instanceof HTMLDivElement)) {
    throw new Error("Expected Plot to be wrapped in a transition layer");
  }
  return layer;
}

describe("TimeSeriesChartCard bounded stacked cross-fade", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let reduceMotion: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    reduceMotion = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: reduceMotion,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(16), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
      window.clearTimeout(handle),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Card />));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts one Plot steady, two through the 250ms handoff, then one final Plot", () => {
    expect(plots(container)).toHaveLength(1);
    expect(activePlot(container).dataset.visibility).toBe("visible,visible");

    clickLegend(container, 0);
    expect(plots(container)).toHaveLength(2);
    expect(activePlot(container).dataset.visibility).toBe("visible,visible");
    expect(inactivePlot(container).dataset.visibility).toBe(
      "legendonly,visible",
    );

    act(() => vi.advanceTimersByTime(16));
    expect(plots(container)).toHaveLength(2);
    expect(activePlot(container).dataset.visibility).toBe("legendonly,visible");

    const incomingLayer = layerFor(activePlot(container));
    const outgoingLayer = layerFor(inactivePlot(container));
    expect(incomingLayer.style.opacity).toBe("1");
    expect(incomingLayer.style.visibility).toBe("visible");
    expect(incomingLayer.style.zIndex).toBe("1");
    expect(incomingLayer.style.pointerEvents).toBe("auto");
    expect(outgoingLayer.style.opacity).toBe("0");
    expect(outgoingLayer.style.zIndex).toBe("0");
    expect(outgoingLayer.style.pointerEvents).toBe("none");
    expect(outgoingLayer.style.transition).toContain("visibility 0s 250ms");

    act(() => vi.advanceTimersByTime(249));
    expect(plots(container)).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(plots(container)).toHaveLength(1);
    expect(activePlot(container).dataset.visibility).toBe("legendonly,visible");
  });

  it("replaces the secondary target across rapid toggles without stale promotion", () => {
    let maximumPlots = plots(container).length;
    const recordMaximum = () => {
      maximumPlots = Math.max(maximumPlots, plots(container).length);
    };

    clickLegend(container, 0);
    recordMaximum();
    act(() => vi.advanceTimersByTime(16));
    recordMaximum();

    // First retarget asks for both traces hidden. Before that frame commits,
    // retarget again to only Series B hidden; the abandoned target must never
    // become active later.
    clickLegend(container, 1);
    recordMaximum();
    clickLegend(container, 0);
    recordMaximum();
    act(() => vi.advanceTimersByTime(16));
    recordMaximum();

    expect(maximumPlots).toBe(2);
    expect(activePlot(container).dataset.visibility).toBe("visible,legendonly");

    // Cross the first transition's now-cancelled completion deadline. The
    // latest transition remains intact until its own 250ms completes.
    act(() => vi.advanceTimersByTime(234));
    expect(plots(container)).toHaveLength(2);
    expect(activePlot(container).dataset.visibility).toBe("visible,legendonly");
    act(() => vi.advanceTimersByTime(16));

    expect(plots(container)).toHaveLength(1);
    expect(activePlot(container).dataset.visibility).toBe("visible,legendonly");
    act(() => vi.advanceTimersByTime(1_000));
    expect(plots(container)).toHaveLength(1);
  });

  it("clears custom hover owned by the outgoing Plot before retargeting", () => {
    act(() => root?.render(<Card customSortedHover />));
    const hoverButton =
      activePlot(container).querySelector<HTMLButtonElement>(
        "[data-hover-first]",
      );
    if (!hoverButton) throw new Error("Expected hover trigger");

    act(() => hoverButton.click());
    expect(container.textContent).toContain("Series A");

    clickLegend(container, 0);
    expect(container.textContent).not.toContain("Series A");
    expect(plots(container)).toHaveLength(2);
  });

  it("settles reduced-motion toggles immediately with one Plot", () => {
    reduceMotion = true;

    clickLegend(container, 0);

    expect(plots(container)).toHaveLength(1);
    expect(activePlot(container).dataset.visibility).toBe("legendonly,visible");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the completion timer when the card unmounts mid-fade", () => {
    clickLegend(container, 0);
    act(() => vi.advanceTimersByTime(16));
    expect(vi.getTimerCount()).toBe(1);

    act(() => root?.unmount());
    root = null;

    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1_000));
  });

  it("cancels the preparation frame when the card unmounts before handoff", () => {
    clickLegend(container, 0);
    expect(vi.getTimerCount()).toBe(1);

    act(() => root?.unmount());
    root = null;

    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1_000));
  });
});
