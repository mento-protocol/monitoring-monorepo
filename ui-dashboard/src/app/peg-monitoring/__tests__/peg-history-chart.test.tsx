/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
import { PegHistoryChart } from "../_components/peg-history-chart";
import type { PegHistoryPoint } from "../_lib/peg-chart-scale";

const NOW_MS = Date.UTC(2026, 7, 11, 16, 0);
const policy = makePegMonitoringResponse().packages[0]!.policy;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const point = (agoMs: number, bps: number): PegHistoryPoint => ({
  at: (NOW_MS - agoMs) / 1_000,
  bps,
});

const series: PegHistoryPoint[] = [
  point(20 * 86_400_000, -40),
  point(3 * 86_400_000, -18),
  point(3_600_000, 0),
  point(60_000, -3.1),
];

const render = () =>
  act(() =>
    root.render(
      <PegHistoryChart
        policy={policy}
        nowBps={-3.1}
        tone="healthy"
        measurement="Slippage when selling 50k EUROP for EUR on Bitvavo"
        nowMs={NOW_MS}
        series={series}
      />,
    ),
  );

const readings = () => container.querySelectorAll("ul.sr-only li");

describe("PegHistoryChart ranges", () => {
  it("plots only the readings inside the selected range", () => {
    render();
    // Default 7d: the 20-day-old reading is out of window.
    expect(readings()).toHaveLength(3);
    expect(
      container.querySelector("svg")!.getAttribute("aria-label"),
    ).toContain("over 7d: 3 readings");

    const chip = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "24h",
    )!;
    act(() => chip.click());
    expect(readings()).toHaveLength(2);
    expect(
      container.querySelector("svg")!.getAttribute("aria-label"),
    ).toContain("over 24h: 2 readings");

    const wide = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "30d",
    )!;
    act(() => wide.click());
    expect(readings()).toHaveLength(4);
  });

  it("labels an exact-target reading as at target, matching the rows", () => {
    render();
    const texts = [...readings()].map((item) => item.textContent);
    expect(texts.some((text) => text!.endsWith("· at target"))).toBe(true);
    expect(texts.some((text) => text!.includes("0 bps above"))).toBe(false);
  });
});
