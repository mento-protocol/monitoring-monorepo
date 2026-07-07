/** @vitest-environment jsdom */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type CSSProperties, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { axe } from "vitest-axe";

vi.mock("plotly.js-basic-dist-min", () => ({ default: {} }));
vi.mock("react-plotly.js/factory", () => ({
  default: () =>
    function MockPlot({
      className,
      style,
    }: {
      className?: string;
      style?: CSSProperties;
    }) {
      return (
        <div data-testid="plotly-graph" className={className} style={style} />
      );
    },
}));

import AccessiblePlot from "@/lib/react-plotly-basic";

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

function render(element: ReactElement) {
  act(() => {
    root.render(element);
  });
}

describe("Plotly chart accessibility wrapper", () => {
  it("exposes a named group with a referenced text alternative", async () => {
    render(
      <AccessiblePlot
        ariaLabel="Daily volume chart for USDm"
        textAlternative="Daily volume chart with 30 daily buckets and two series."
        data={[]}
        layout={{}}
        style={{ height: 220, width: "100%" }}
      />,
    );

    const chart = container.querySelector('[role="group"]');
    expect(chart?.getAttribute("aria-label")).toBe(
      "Daily volume chart for USDm",
    );
    const summaryId = chart?.getAttribute("aria-describedby");
    expect(summaryId).toBeTruthy();
    expect(document.getElementById(summaryId ?? "")?.textContent).toBe(
      "Daily volume chart with 30 daily buckets and two series.",
    );
    expect(
      container.querySelector('[data-testid="plotly-graph"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("can hide inactive pre-rendered chart layers from assistive tech", () => {
    render(
      <AccessiblePlot
        ariaLabel="Inactive chart layer"
        textAlternative="Inactive layer summary"
        ariaHidden
        data={[]}
        layout={{}}
      />,
    );

    expect(
      container.querySelector('[role="group"]')?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
