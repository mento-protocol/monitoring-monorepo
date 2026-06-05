/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VolumeRangeKey } from "@/lib/volume";
import { SECONDS_PER_DAY } from "@/lib/time-series";

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

import { useVolumeUrlState, type Venue } from "../url-state";

type UrlStateResult = ReturnType<typeof useVolumeUrlState>;
type ResultRef = { current: UrlStateResult | null };

function HookWrapper({
  resultRef,
  canUseVolumeFilters,
}: {
  resultRef: ResultRef;
  canUseVolumeFilters: boolean;
}) {
  resultRef.current = useVolumeUrlState({ canUseVolumeFilters });
  return null;
}

let container: HTMLElement;
let root: Root;

function setup(url = "/volume") {
  window.history.replaceState(window.history.state, "", url);
  mockSearchParams = new URLSearchParams(window.location.search);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function renderHook(canUseVolumeFilters = true): ResultRef {
  const ref: ResultRef = { current: null };
  act(() => {
    root.render(
      <HookWrapper resultRef={ref} canUseVolumeFilters={canUseVolumeFilters} />,
    );
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

describe("useVolumeUrlState", () => {
  it("reads a direct-load URL without waiting for popstate", () => {
    setup(
      "/volume?range=90d&actors=all&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc&venue=v2",
    );
    const ref = renderHook();

    expect(ref.current?.range).toBe("90d");
    expect(ref.current?.actorFilter).toBe("all");
    expect(ref.current?.includeProtocolActors).toBe(true);
    expect(ref.current?.exclusions).toEqual({
      addresses: ["0x00000000000000000000000000000000000000aa"],
      sources: ["cluster-abc"],
    });
    expect(ref.current?.venue).toBe("v2");
    expect(ref.current?.cutoff).toBeGreaterThan(0);
  });

  it("locks external users to all volume and strips private filter params", () => {
    setup(
      "/volume?foo=1&range=30d&actors=organic&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc",
    );
    const ref = renderHook(false);

    expect(ref.current?.canUseVolumeFilters).toBe(false);
    expect(ref.current?.actorFilter).toBe("all");
    expect(ref.current?.includeProtocolActors).toBe(true);
    expect(ref.current?.exclusions).toEqual({ addresses: [], sources: [] });
    expect(window.location.search).toBe("?foo=1&range=30d");

    act(() => {
      ref.current?.updateIncludeProtocolActors(false);
    });
    expect(ref.current?.actorFilter).toBe("all");
    expect(ref.current?.includeProtocolActors).toBe(true);
    expect(window.location.search).toBe("?foo=1&range=30d");

    act(() => {
      ref.current?.updateExclusions({
        addresses: ["0x00000000000000000000000000000000000000bb"],
        sources: ["cluster-def"],
      });
    });
    expect(ref.current?.exclusions).toEqual({ addresses: [], sources: [] });
    expect(window.location.search).toBe("?foo=1&range=30d");
  });

  it("falls back to default state for invalid params", () => {
    setup("/volume?range=forever&actors=protocol&venue=v4");
    const ref = renderHook();

    expect(ref.current?.range).toBe("7d");
    expect(ref.current?.actorFilter).toBe("organic");
    expect(ref.current?.includeProtocolActors).toBe(false);
    expect(ref.current?.exclusions).toEqual({ addresses: [], sources: [] });
    expect(ref.current?.venue).toBe("v3");
  });

  it("writes URL state with replaceState while preserving unrelated params and hash", () => {
    setup("/volume?foo=1#top");
    const ref = renderHook();

    act(() => {
      ref.current?.updateRange("30d");
    });
    expect(window.location.pathname).toBe("/volume");
    expect(window.location.search).toBe("?foo=1&range=30d");
    expect(window.location.hash).toBe("#top");

    act(() => {
      ref.current?.updateIncludeProtocolActors(true);
    });
    expect(window.location.search).toBe("?foo=1&range=30d&actors=all");

    act(() => {
      ref.current?.updateExclusions({
        addresses: ["0x00000000000000000000000000000000000000aa"],
        sources: ["cluster-abc"],
      });
    });
    expect(window.location.search).toBe(
      "?foo=1&range=30d&actors=all&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc",
    );

    act(() => {
      ref.current?.updateVenue("v2");
    });
    expect(window.location.search).toBe(
      "?foo=1&range=30d&actors=all&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc&venue=v2",
    );

    act(() => {
      ref.current?.updateRange("7d");
    });
    expect(window.location.search).toBe(
      "?foo=1&actors=all&venue=v2&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc",
    );

    act(() => {
      ref.current?.updateIncludeProtocolActors(false);
    });
    expect(window.location.search).toBe(
      "?foo=1&venue=v2&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc",
    );

    act(() => {
      ref.current?.updateVenue("v3");
    });
    expect(window.location.search).toBe(
      "?foo=1&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc",
    );

    act(() => {
      ref.current?.updateExclusions({ addresses: [], sources: [] });
    });
    expect(window.location.search).toBe("?foo=1");
  });

  it("syncs state from browser back-forward popstate", () => {
    setup("/volume?range=90d&actors=all&venue=v2");
    const ref = renderHook();

    window.history.replaceState(window.history.state, "", "/volume");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(ref.current?.range).toBe("7d");
    expect(ref.current?.actorFilter).toBe("organic");
    expect(ref.current?.includeProtocolActors).toBe(false);
    expect(ref.current?.exclusions).toEqual({ addresses: [], sources: [] });
    expect(ref.current?.venue).toBe("v3");
  });

  it("keeps external users locked to all volume across popstate", () => {
    setup("/volume?actors=all");
    const ref = renderHook(false);

    expect(window.location.search).toBe("");

    window.history.replaceState(
      window.history.state,
      "",
      "/volume?actors=organic&venue=v2&exclude=0x00000000000000000000000000000000000000aa&excludeSources=cluster-abc",
    );
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(ref.current?.actorFilter).toBe("all");
    expect(ref.current?.includeProtocolActors).toBe(true);
    expect(ref.current?.exclusions).toEqual({ addresses: [], sources: [] });
    expect(ref.current?.venue).toBe("v2");
    expect(window.location.search).toBe("?venue=v2");
  });

  it("refreshes the UTC day key at midnight so cutoffs can recompute", () => {
    vi.setSystemTime(new Date("2026-01-01T23:59:30Z"));
    setup("/volume?range=24h");
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
    setup("/volume?range=all");
    const ref = renderHook();

    expect(ref.current?.range satisfies VolumeRangeKey | undefined).toBe("all");
    expect(ref.current?.cutoff).toBe(0);
  });

  it("accepts valid venue update values only through the typed API", () => {
    setup("/volume");
    const ref = renderHook();

    act(() => {
      ref.current?.updateVenue("v2" satisfies Venue);
    });

    expect(ref.current?.venue).toBe("v2");
    expect(window.location.search).toBe("?venue=v2");
  });
});
