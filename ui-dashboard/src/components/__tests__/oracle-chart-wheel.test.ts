/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachOracleWheelHandler } from "../oracle-chart-wheel";

// JSDOM gives us `WheelEvent` + `dispatchEvent` out of the box. We mock
// `window.Plotly` and override `getBoundingClientRect` (which JSDOM defaults
// to all-zeros) so the handler's cursor-area math is deterministic.

describe("attachOracleWheelHandler", () => {
  let graphDiv: HTMLDivElement;
  let cleanup: () => void;
  let relayoutSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    graphDiv = document.createElement("div");
    document.body.appendChild(graphDiv);

    // Deterministic 800x400 box anchored at (0, 0) so the cursor-position
    // math is unambiguous: plotL=64, plotR=776, plotT=8, plotB=360 (after
    // the rangeslider 8% strip + bottom margin).
    Object.defineProperty(graphDiv, "getBoundingClientRect", {
      value: () => ({
        width: 800,
        height: 400,
        left: 0,
        top: 0,
        right: 800,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    (graphDiv as unknown as { _fullLayout: unknown })._fullLayout = {
      xaxis: { range: ["2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z"] },
      yaxis: { range: [0.9, 1.1] },
      margin: { l: 64, r: 24, t: 8, b: 8 },
    };

    relayoutSpy = vi.fn(() => Promise.resolve());
    (window as unknown as { Plotly: unknown }).Plotly = {
      relayout: relayoutSpy,
    };

    cleanup = attachOracleWheelHandler(graphDiv);
  });

  afterEach(() => {
    cleanup();
    document.body.removeChild(graphDiv);
    delete (window as unknown as { Plotly?: unknown }).Plotly;
  });

  /** Helper: dispatch a WheelEvent at (clientX, clientY) with a spy on `preventDefault`. */
  function fireWheel(opts: {
    clientX: number;
    clientY: number;
    deltaY?: number;
    deltaX?: number;
  }) {
    const ev = new WheelEvent("wheel", {
      clientX: opts.clientX,
      clientY: opts.clientY,
      deltaY: opts.deltaY ?? 0,
      deltaX: opts.deltaX ?? 0,
      cancelable: true,
      bubbles: true,
    });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    graphDiv.dispatchEvent(ev);
    return { ev, preventSpy };
  }

  it("zooms X (not Y) when cursor is over the plot area", () => {
    // Cursor at (400, 180) — inside [64, 776] × [8, 360].
    const { preventSpy } = fireWheel({
      clientX: 400,
      clientY: 180,
      deltaY: 100,
    });
    expect(preventSpy).toHaveBeenCalledTimes(1);
    expect(relayoutSpy).toHaveBeenCalledTimes(1);
    const update = relayoutSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(update).toHaveProperty("xaxis.range");
    expect(update).not.toHaveProperty("yaxis.range");
  });

  it("zooms Y (not X) when cursor is over the y-axis tick column", () => {
    // Cursor at (30, 180) — to the left of plotL=64, within plotT/plotB.
    const { preventSpy } = fireWheel({
      clientX: 30,
      clientY: 180,
      deltaY: 100,
    });
    expect(preventSpy).toHaveBeenCalledTimes(1);
    expect(relayoutSpy).toHaveBeenCalledTimes(1);
    const update = relayoutSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(update).toHaveProperty("yaxis.range");
    expect(update).not.toHaveProperty("xaxis.range");
  });

  it("ignores cursors below the plot (rangeslider / bottom margin)", () => {
    // Cursor at (400, 390) — below plotB=360.
    const { preventSpy } = fireWheel({
      clientX: 400,
      clientY: 390,
      deltaY: 100,
    });
    expect(preventSpy).not.toHaveBeenCalled();
    expect(relayoutSpy).not.toHaveBeenCalled();
  });

  it("ignores cursors above the plot (top margin)", () => {
    // Cursor at (400, 4) — above plotT=8.
    const { preventSpy } = fireWheel({
      clientX: 400,
      clientY: 4,
      deltaY: 100,
    });
    expect(preventSpy).not.toHaveBeenCalled();
    expect(relayoutSpy).not.toHaveBeenCalled();
  });

  it("ignores cursors right of the plot (right margin)", () => {
    // Cursor at (790, 180) — to the right of plotR=776.
    const { preventSpy } = fireWheel({
      clientX: 790,
      clientY: 180,
      deltaY: 100,
    });
    expect(preventSpy).not.toHaveBeenCalled();
    expect(relayoutSpy).not.toHaveBeenCalled();
  });

  it("drops sub-pixel scroll noise (|deltaY + deltaX| < 1) without preventDefault", () => {
    // Plot-area cursor but tiny delta — common at trackpad gesture start/end.
    // This is the PR-624 round-2 fix Cursor Bugbot caught; the early-return
    // sits BEFORE preventDefault so the page still gets normal scroll noise.
    const { preventSpy } = fireWheel({
      clientX: 400,
      clientY: 180,
      deltaY: 0.4,
      deltaX: 0.3,
    });
    expect(preventSpy).not.toHaveBeenCalled();
    expect(relayoutSpy).not.toHaveBeenCalled();
  });

  it("uses deltaX (trackpad horizontal scroll) for plot-area zoom", () => {
    // deltaY=0, deltaX=120 → handler should still recognize this as a zoom
    // gesture (handler sums deltaY + deltaX).
    const { preventSpy } = fireWheel({
      clientX: 400,
      clientY: 180,
      deltaY: 0,
      deltaX: 120,
    });
    expect(preventSpy).toHaveBeenCalledTimes(1);
    expect(relayoutSpy).toHaveBeenCalledTimes(1);
  });

  it("calls preventDefault only when the handler actually fires", () => {
    // Two events: one plot-area handled, one margin-area ignored. Verify
    // preventDefault count matches handler-fire count.
    const handled = fireWheel({ clientX: 400, clientY: 180, deltaY: 100 });
    const ignored = fireWheel({ clientX: 400, clientY: 390, deltaY: 100 });
    expect(handled.preventSpy).toHaveBeenCalledTimes(1);
    expect(ignored.preventSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when window.Plotly is unavailable", () => {
    delete (window as unknown as { Plotly?: unknown }).Plotly;
    const { preventSpy } = fireWheel({
      clientX: 400,
      clientY: 180,
      deltaY: 100,
    });
    expect(preventSpy).not.toHaveBeenCalled();
    expect(relayoutSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when _fullLayout ranges are missing", () => {
    (graphDiv as unknown as { _fullLayout: unknown })._fullLayout = {
      margin: { l: 64, r: 24, t: 8, b: 8 },
    };
    const { preventSpy } = fireWheel({
      clientX: 400,
      clientY: 180,
      deltaY: 100,
    });
    expect(preventSpy).not.toHaveBeenCalled();
    expect(relayoutSpy).not.toHaveBeenCalled();
  });

  it("cleanup detaches the wheel listener", () => {
    cleanup();
    fireWheel({ clientX: 400, clientY: 180, deltaY: 100 });
    expect(relayoutSpy).not.toHaveBeenCalled();
    // Reset cleanup so afterEach's invocation is a no-op (already detached).
    cleanup = () => {};
  });
});
