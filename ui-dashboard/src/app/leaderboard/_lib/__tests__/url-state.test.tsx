/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardRangeKey } from "@/lib/leaderboard";
import { SECONDS_PER_DAY } from "@/lib/time-series";

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

import { useLeaderboardUrlState, type Venue } from "../url-state";

type UrlStateResult = ReturnType<typeof useLeaderboardUrlState>;
type ResultRef = { current: UrlStateResult | null };

function HookWrapper({ resultRef }: { resultRef: ResultRef }) {
  resultRef.current = useLeaderboardUrlState();
  return null;
}

let container: HTMLElement;
let root: Root;

function setup(url = "/leaderboard") {
  window.history.replaceState(window.history.state, "", url);
  mockSearchParams = new URLSearchParams(window.location.search);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function renderHook(): ResultRef {
  const ref: ResultRef = { current: null };
  act(() => {
    root.render(<HookWrapper resultRef={ref} />);
  });
  return ref;
}

function teardown() {
  act(() => {
    root.unmount();
  });
  container.remove();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
  mockSearchParams = new URLSearchParams();
});

afterEach(() => {
  teardown();
  vi.useRealTimers();
});

describe("useLeaderboardUrlState", () => {
  it("reads a direct-load URL without waiting for popstate", () => {
    setup("/leaderboard?range=90d&system=1&venue=v2");
    const ref = renderHook();

    expect(ref.current?.range).toBe("90d");
    expect(ref.current?.showSystem).toBe(true);
    expect(ref.current?.venue).toBe("v2");
    expect(ref.current?.cutoff).toBeGreaterThan(0);
  });

  it("falls back to default state for invalid params", () => {
    setup("/leaderboard?range=forever&system=true&venue=v4");
    const ref = renderHook();

    expect(ref.current?.range).toBe("7d");
    expect(ref.current?.showSystem).toBe(false);
    expect(ref.current?.venue).toBe("v3");
  });

  it("writes URL state with replaceState while preserving unrelated params and hash", () => {
    setup("/leaderboard?foo=1#top");
    const ref = renderHook();

    act(() => {
      ref.current?.updateRange("30d");
    });
    expect(window.location.pathname).toBe("/leaderboard");
    expect(window.location.search).toBe("?foo=1&range=30d");
    expect(window.location.hash).toBe("#top");

    act(() => {
      ref.current?.updateShowSystem(true);
    });
    expect(window.location.search).toBe("?foo=1&range=30d&system=1");

    act(() => {
      ref.current?.updateVenue("v2");
    });
    expect(window.location.search).toBe("?foo=1&range=30d&system=1&venue=v2");

    act(() => {
      ref.current?.updateRange("7d");
    });
    expect(window.location.search).toBe("?foo=1&system=1&venue=v2");

    act(() => {
      ref.current?.updateShowSystem(false);
    });
    expect(window.location.search).toBe("?foo=1&venue=v2");

    act(() => {
      ref.current?.updateVenue("v3");
    });
    expect(window.location.search).toBe("?foo=1");
  });

  it("syncs state from browser back-forward popstate", () => {
    setup("/leaderboard?range=90d&system=1&venue=v2");
    const ref = renderHook();

    window.history.replaceState(window.history.state, "", "/leaderboard");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(ref.current?.range).toBe("7d");
    expect(ref.current?.showSystem).toBe(false);
    expect(ref.current?.venue).toBe("v3");
  });

  it("refreshes the UTC day key at midnight so cutoffs can recompute", () => {
    vi.setSystemTime(new Date("2026-01-01T23:59:30Z"));
    setup("/leaderboard?range=24h");
    const ref = renderHook();
    const before = ref.current?.utcDayKey;

    vi.setSystemTime(new Date("2026-01-02T00:00:30Z"));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(ref.current?.utcDayKey).toBe((before ?? 0) + 1);
    expect(ref.current?.cutoff).toBe(
      Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY,
    );
  });

  it("keeps the all-time range cutoff at zero", () => {
    setup("/leaderboard?range=all");
    const ref = renderHook();

    expect(ref.current?.range satisfies LeaderboardRangeKey | undefined).toBe(
      "all",
    );
    expect(ref.current?.cutoff).toBe(0);
  });

  it("accepts valid venue update values only through the typed API", () => {
    setup("/leaderboard");
    const ref = renderHook();

    act(() => {
      ref.current?.updateVenue("v2" satisfies Venue);
    });

    expect(ref.current?.venue).toBe("v2");
    expect(window.location.search).toBe("?venue=v2");
  });
});
