/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCoalescedRelayout } from "../oracle-chart";

// Enable React's act() in the jsdom environment (mirrors the repo's other
// createRoot+act tests). Typed cast avoids an `any` + eslint-disable.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Plotly emits X range as ISO-ish strings; the handler forwards unix seconds.
const sec = (iso: string) => new Date(iso).getTime() / 1000;
const relayout = (loIso: string, hiIso: string) => ({
  "xaxis.range[0]": loIso,
  "xaxis.range[1]": hiIso,
});

// Deterministic rAF queue — jsdom's rAF + fake-timer interplay is fiddly, and a
// manual queue makes the "exactly one flush per frame" assertions exact.
let rafQueue: Array<FrameRequestCallback | null>;
const flushFrame = () => {
  const cbs = rafQueue;
  rafQueue = [];
  for (const cb of cbs) cb?.(0);
};

const setVisibleRange = vi.fn();
const setShowAll = vi.fn();
const onVisibleXRangeChange = vi.fn();

let container: HTMLDivElement;
let root: Root;
let handler: (e: unknown) => void;
let mounted = false;

function Harness() {
  // useCallback keeps the returned handler referentially stable across renders,
  // so capturing it in render is deterministic for the test.
  handler = useCoalescedRelayout(
    setVisibleRange,
    setShowAll,
    onVisibleXRangeChange,
  );
  return null;
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length; // 1-based, always truthy
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    if (id > 0) rafQueue[id - 1] = null;
  });
  setVisibleRange.mockClear();
  setShowAll.mockClear();
  onVisibleXRangeChange.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<Harness />));
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  mounted = false;
  vi.unstubAllGlobals();
});

describe("useCoalescedRelayout", () => {
  it("coalesces multiple relayouts in one frame into a single latest-wins update", () => {
    act(() => {
      handler(relayout("2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z"));
      handler(relayout("2026-05-02T00:00:00Z", "2026-05-09T00:00:00Z"));
    });
    // Nothing applied until the frame fires — the wheel's own Plotly.relayout
    // has already reframed the axis; the React work waits for the frame.
    expect(setVisibleRange).not.toHaveBeenCalled();

    act(() => flushFrame());
    expect(setVisibleRange).toHaveBeenCalledTimes(1);
    expect(setVisibleRange).toHaveBeenCalledWith([
      sec("2026-05-02T00:00:00Z"),
      sec("2026-05-09T00:00:00Z"),
    ]); // latest event wins, matching the chart's final axis state
    expect(setShowAll).toHaveBeenCalledTimes(1);
    expect(setShowAll).toHaveBeenCalledWith(false);
    expect(onVisibleXRangeChange).toHaveBeenCalledTimes(1);
  });

  it("schedules only one frame for a burst (not one rAF per event)", () => {
    act(() => {
      handler(relayout("2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z"));
      handler(relayout("2026-05-02T00:00:00Z", "2026-05-09T00:00:00Z"));
      handler(relayout("2026-05-03T00:00:00Z", "2026-05-10T00:00:00Z"));
    });
    expect(rafQueue.filter(Boolean)).toHaveLength(1);
  });

  it("re-arms on the next frame after a flush", () => {
    act(() =>
      handler(relayout("2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z")),
    );
    act(() => flushFrame());
    expect(setVisibleRange).toHaveBeenCalledTimes(1);

    act(() =>
      handler(relayout("2026-05-05T00:00:00Z", "2026-05-12T00:00:00Z")),
    );
    act(() => flushFrame());
    expect(setVisibleRange).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending frame on unmount (no setState after teardown)", () => {
    act(() =>
      handler(relayout("2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z")),
    );
    act(() => root.unmount());
    mounted = false;

    act(() => flushFrame());
    expect(setVisibleRange).not.toHaveBeenCalled();
  });
});
