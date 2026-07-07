/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STABLES_RANGE,
  useStablesRangeUrlState,
} from "./use-stables-range-url-state";
import type { RangeKey } from "./types";

const mockSearchParams = vi.hoisted(() => ({
  current: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams.current,
}));

let latest: {
  range: RangeKey;
  updateRange: (next: RangeKey) => void;
} | null = null;

function Probe(): null {
  latest = useStablesRangeUrlState();
  return null;
}

function setUrl(url: string) {
  window.history.replaceState(window.history.state, "", url);
  mockSearchParams.current = new URLSearchParams(window.location.search);
}

function renderProbe(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  return { root, container };
}

function cleanup(handle: { root: Root; container: HTMLDivElement } | null) {
  if (handle == null) return;
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

describe("useStablesRangeUrlState", () => {
  let handle: { root: Root; container: HTMLDivElement } | null = null;

  beforeEach(() => {
    latest = null;
    setUrl("/stables");
  });

  afterEach(() => {
    cleanup(handle);
    handle = null;
  });

  it("reads direct-load range state from the URL", () => {
    setUrl("/stables?range=90d&minSupplyChangeUsd=10");

    handle = renderProbe();

    expect(latest?.range).toBe("90d");
    expect(window.location.search).toBe("?range=90d&minSupplyChangeUsd=10");
  });

  it("writes range with replaceState while preserving sibling params", () => {
    setUrl("/stables?minSupplyChangeUsd=10#chart");
    const replaceState = vi.spyOn(window.history, "replaceState");
    handle = renderProbe();

    act(() => {
      latest?.updateRange("90d");
    });

    expect(latest?.range).toBe("90d");
    expect(window.location.search).toBe("?minSupplyChangeUsd=10&range=90d");
    expect(window.location.hash).toBe("#chart");
    expect(replaceState).toHaveBeenCalled();
  });

  it("strips the default range from the URL", () => {
    setUrl("/stables?range=90d&minSupplyChangeUsd=10");
    handle = renderProbe();

    act(() => {
      latest?.updateRange(DEFAULT_STABLES_RANGE);
    });

    expect(latest?.range).toBe(DEFAULT_STABLES_RANGE);
    expect(window.location.search).toBe("?minSupplyChangeUsd=10");
  });

  it("canonicalizes invalid range params on mount", () => {
    setUrl("/stables?range=forever&minSupplyChangeUsd=10");

    handle = renderProbe();

    expect(latest?.range).toBe(DEFAULT_STABLES_RANGE);
    expect(window.location.search).toBe("?minSupplyChangeUsd=10");
  });

  it("syncs range from browser back-forward popstate", () => {
    setUrl("/stables?range=90d");
    handle = renderProbe();
    expect(latest?.range).toBe("90d");

    window.history.replaceState(window.history.state, "", "/stables");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(latest?.range).toBe(DEFAULT_STABLES_RANGE);
  });
});
