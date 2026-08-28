/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpTroveLedgerEventRow } from "../../_lib/ledger";

// Captures every Plot render's props (data/layout/config) so assertions run
// against what Plotly would actually receive — the real chunk never loads.
const plotCaptures = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockPlot(props: Record<string, unknown>) {
      plotCaptures.push(props);
      return <div data-testid="plot" />;
    },
}));

import { TroveBalanceChart } from "../trove-balance-chart";

const NOW = 1_767_225_600;
const DAY = 86_400;
const D18 = BigInt(10) ** BigInt(18);

function wei(amount: number): string {
  return (BigInt(amount) * D18).toString();
}

function ledgerRow(
  overrides: Partial<CdpTroveLedgerEventRow> = {},
): CdpTroveLedgerEventRow {
  return {
    id: "42220_100_1",
    operation: 2,
    collChange: "0",
    debtChange: "0",
    debtIncreaseFromUpfrontFee: "0",
    debtIncreaseFromRedist: "0",
    collIncreaseFromRedist: "0",
    annualInterestRate: "0",
    debtBefore: wei(1_000),
    debtAfter: wei(1_000),
    collBefore: wei(500),
    collAfter: wei(500),
    statusBefore: "active",
    statusAfter: "active",
    redemptionFeeCredited: null,
    isRebalance: null,
    redemptionPrice: null,
    priceAtEvent: null,
    icrAfterBps: null,
    timestamp: String(NOW - 10 * DAY),
    blockNumber: "100",
    logIndex: 1,
    txHash: "0xtx",
    ...overrides,
  };
}

type ChartProps = React.ComponentProps<typeof TroveBalanceChart>;

function chartProps(overrides: Partial<ChartProps> = {}): ChartProps {
  return {
    rows: [
      ledgerRow({
        id: "42220_100_1",
        timestamp: String(NOW - 10 * DAY),
        collAfter: wei(40_000),
        debtAfter: wei(25_000),
      }),
      ledgerRow({
        id: "42220_200_1",
        timestamp: String(NOW - DAY),
        blockNumber: "200",
        collAfter: wei(15_000),
        debtAfter: wei(6_500),
      }),
    ],
    truncated: false,
    anchored: true,
    debtSnapshotsComplete: true,
    isLoading: false,
    error: undefined,
    hasLoadedOnce: true,
    debtSymbol: "GBPm",
    ...overrides,
  };
}

type Handle = { container: HTMLElement; root: Root };

function setup(): Handle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function render(handle: Handle, props: ChartProps) {
  act(() => {
    handle.root.render(<TroveBalanceChart {...props} />);
  });
}

function lastCapture(): Record<string, unknown> {
  const capture = plotCaptures[plotCaptures.length - 1];
  expect(capture, "expected at least one Plot render").toBeDefined();
  return capture!;
}

type Trace = {
  x: string[];
  y: number[];
  yaxis: string;
  mode: string;
  line: { shape: string; color: string };
  hovertemplate: string;
};

function traces(): Trace[] {
  return lastCapture().data as Trace[];
}

function layout(): Record<string, unknown> {
  return lastCapture().layout as Record<string, unknown>;
}

describe("TroveBalanceChart", () => {
  let handle: Handle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.stubGlobal("IntersectionObserver", undefined);
    plotCaptures.length = 0;
    handle = setup();
  });

  afterEach(() => {
    if (handle) {
      act(() => handle!.root.unmount());
      handle.container.remove();
      handle = null;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders two stacked step panels with single-unit hovers — the debt hover never shows a dollar prefix", () => {
    render(handle!, chartProps());

    const [coll, debt] = traces();
    expect(coll!.yaxis).toBe("y");
    expect(debt!.yaxis).toBe("y2");
    for (const trace of traces()) {
      expect(trace.line.shape).toBe("hv");
    }
    expect(coll!.hovertemplate).toContain("USDm");
    expect(debt!.hovertemplate).toContain("GBPm");
    // NEVER dollar-prefixed anywhere in the traces (the shared chart card
    // hardcodes `$%{y}` — the reason this sibling exists).
    expect(JSON.stringify(traces())).not.toContain("$");
    // Two panels, one shared x-axis, no dual-axis overlay.
    expect(layout().yaxis3).toBeUndefined();
    expect((layout().yaxis2 as { overlaying?: string }).overlaying).toBe(
      undefined,
    );
  });

  it("extends recorded balances flat to now, so a quiet window still shows the standing position", () => {
    render(handle!, chartProps());

    const [coll] = traces();
    // Two event vertices + the now-extension.
    expect(coll!.x).toHaveLength(3);
    expect(coll!.x[2]).toBe(new Date(NOW * 1000).toISOString());
    expect(coll!.y).toEqual([40_000, 15_000, 15_000]);
  });

  it("defaults to All and re-windows with the pre-window step anchor when a range pill is pressed", () => {
    render(handle!, chartProps());

    const pills = Array.from(
      handle!.container.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="Trove chart time range"] button',
      ),
    );
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "1d",
      "7d",
      "30d",
      "All",
    ]);
    expect(pills.map((pill) => pill.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
      "true",
    ]);

    act(() => {
      pills[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(pills[1]!.getAttribute("aria-pressed")).toBe("true");

    const [coll] = traces();
    // The 10-days-ago vertex is outside the 7d window, but its value is
    // carried in re-anchored AT the cutoff — the panel never starts mid-air.
    const cutoffIso = new Date((NOW - 7 * DAY) * 1000).toISOString();
    expect(coll!.x[0]).toBe(cutoffIso);
    expect(coll!.y).toEqual([40_000, 15_000, 15_000]);
  });

  it("adds the ICR percentage panel only when price data exists — its own axis, never shared", () => {
    render(
      handle!,
      chartProps({
        rows: [
          ledgerRow({
            id: "42220_100_1",
            timestamp: String(NOW - 10 * DAY),
            icrAfterBps: 11_710,
          }),
          ledgerRow({
            id: "42220_200_1",
            timestamp: String(NOW - DAY),
            blockNumber: "200",
            icrAfterBps: 16_500,
          }),
        ],
      }),
    );

    expect(layout().yaxis3).toBeDefined();
    const icr = traces().find((trace) => trace.yaxis === "y3");
    expect(icr).toBeDefined();
    // A single literal % suffix: Plotly substitutes only %{...} sequences,
    // so %% would render as two percent signs.
    expect(icr!.hovertemplate).toContain("%<br>");
    expect(icr!.hovertemplate).not.toContain("%%");
    expect(icr!.hovertemplate).not.toContain("USDm");
    expect(icr!.y).toEqual([117.1, 165]);
    // Sparse observations render as dots too, not an invisible 1-point line.
    expect(icr!.mode).toBe("lines+markers");
    expect(handle!.container.textContent).not.toContain(
      "ICR panel unavailable",
    );
  });

  it("drops the ICR panel and says so when no row carries price data", () => {
    render(handle!, chartProps());

    expect(layout().yaxis3).toBeUndefined();
    expect(traces().some((trace) => trace.yaxis === "y3")).toBe(false);
    expect(handle!.container.textContent).toContain("ICR panel unavailable");
  });

  it("notes partial ICR coverage when only some rows carry price data", () => {
    render(
      handle!,
      chartProps({
        rows: [
          ledgerRow({ id: "42220_100_1", timestamp: String(NOW - 10 * DAY) }),
          ledgerRow({
            id: "42220_200_1",
            timestamp: String(NOW - DAY),
            blockNumber: "200",
            icrAfterBps: 12_000,
          }),
        ],
      }),
    );

    expect(layout().yaxis3).toBeDefined();
    expect(handle!.container.textContent).toContain(
      "ICR is plotted only at events that carry price data",
    );
  });

  it("switches the debt panel to the explicit batch notice — collateral still renders", () => {
    render(
      handle!,
      chartProps({
        rows: [
          ledgerRow({ id: "42220_100_1", timestamp: String(NOW - 10 * DAY) }),
          ledgerRow({
            id: "42220_200_1",
            timestamp: String(NOW - DAY),
            blockNumber: "200",
            debtBefore: null,
            debtAfter: null,
          }),
        ],
        debtSnapshotsComplete: false,
      }),
    );

    // No debt trace at all — never a gapped or zero-coerced series.
    expect(traces().some((trace) => trace.yaxis === "y2")).toBe(false);
    expect(traces().some((trace) => trace.yaxis === "y")).toBe(true);
    // The panel's frame stays (no layout jump); an in-panel annotation plus
    // an accessible status note replace the series.
    expect(layout().yaxis2).toBeDefined();
    const annotations = layout().annotations as Array<{ text: string }>;
    expect(annotations[0]!.text).toContain("Batch data unavailable");
    const notices = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).map((node) => node.textContent ?? "");
    expect(
      notices.some((text) => text.includes("Batch data unavailable")),
    ).toBe(true);
  });

  it("draws vertical marker lines for redemption and liquidation events", () => {
    const redemptionAt = NOW - 2 * DAY;
    render(
      handle!,
      chartProps({
        rows: [
          ledgerRow({ id: "42220_100_1", timestamp: String(NOW - 10 * DAY) }),
          ledgerRow({
            id: "42220_200_1",
            timestamp: String(redemptionAt),
            blockNumber: "200",
            operation: 6,
            isRebalance: true,
          }),
        ],
      }),
    );

    const shapes = layout().shapes as Array<{
      x0: string;
      line: { color: string; dash: string };
    }>;
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.x0).toBe(new Date(redemptionAt * 1000).toISOString());
    expect(shapes[0]!.line.dash).toBe("dot");
    expect(handle!.container.textContent).toContain(
      "Dotted vertical lines mark redemptions",
    );
  });

  it("escapes a hostile debt symbol before it reaches Plotly's HTML sinks", () => {
    render(handle!, chartProps({ debtSymbol: "G<img>Pm" }));

    const debt = traces().find((trace) => trace.yaxis === "y2");
    expect(debt!.hovertemplate).toContain("G&lt;img&gt;Pm");
    const yaxis2 = layout().yaxis2 as { title: { text: string } };
    expect(yaxis2.title.text).toContain("G&lt;img&gt;Pm");
    expect(yaxis2.title.text).not.toContain("<img>");
  });

  it("suppresses the chart entirely for a truncated history", () => {
    render(handle!, chartProps({ truncated: true }));

    expect(handle!.container.querySelector('[data-testid="plot"]')).toBeNull();
    const status = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).map((node) => node.textContent ?? "");
    expect(
      status.some((text) =>
        text.includes("Chart suppressed — earliest history truncated"),
      ),
    ).toBe(true);
  });

  it("pauses the chart while the ledger snapshot is un-anchored", () => {
    render(handle!, chartProps({ anchored: false }));

    expect(handle!.container.querySelector('[data-testid="plot"]')).toBeNull();
    const status = Array.from(
      handle!.container.querySelectorAll('[role="status"]'),
    ).map((node) => node.textContent ?? "");
    expect(
      status.some((text) =>
        text.includes("Chart paused — the ledger snapshot is mid-update"),
      ),
    ).toBe(true);
  });

  it("announces a loading region while the ledger is still fetching", () => {
    render(
      handle!,
      chartProps({ rows: [], isLoading: true, hasLoadedOnce: false }),
    );

    expect(handle!.container.querySelector('[data-testid="plot"]')).toBeNull();
    const region = handle!.container.querySelector('[role="status"]');
    expect(region?.getAttribute("aria-label")).toBe("Loading trove chart");
  });

  it("shows a confirmed-empty message once the ledger loads with no rows", () => {
    render(
      handle!,
      chartProps({ rows: [], isLoading: false, hasLoadedOnce: true }),
    );

    expect(handle!.container.querySelector('[data-testid="plot"]')).toBeNull();
    expect(handle!.container.textContent).toContain(
      "No ledger events indexed for this trove yet.",
    );
  });

  it("degrades quietly on a first-load ledger failure — the ledger table below owns the alert", () => {
    render(
      handle!,
      chartProps({
        rows: [],
        isLoading: false,
        hasLoadedOnce: false,
        error: new Error("ledger backend down"),
      }),
    );

    expect(handle!.container.querySelector('[data-testid="plot"]')).toBeNull();
    expect(handle!.container.querySelector('[role="alert"]')).toBeNull();
    expect(handle!.container.textContent).toContain(
      "Chart unavailable — the trove ledger failed to load.",
    );
  });

  it("exposes the figure role with a range-aware accessible name and sr-only summary", () => {
    render(handle!, chartProps());

    const figure = handle!.container.querySelector('[role="figure"]');
    expect(figure?.getAttribute("aria-label")).toBe(
      "Collateral and debt over time chart, All range",
    );
    expect(handle!.container.querySelector(".sr-only")?.textContent).toContain(
      "2 ledger events",
    );
  });
});
