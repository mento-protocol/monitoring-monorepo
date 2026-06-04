/** @vitest-environment jsdom */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SUPPLY_CHANGE_MIN_USD } from "./aggregate";

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

import { useSupplyChangeThreshold } from "./use-supply-change-threshold";

type ThresholdResult = ReturnType<typeof useSupplyChangeThreshold>;
type ResultRef = { current: ThresholdResult | null };

function HookWrapper({ resultRef }: { resultRef: ResultRef }) {
  resultRef.current = useSupplyChangeThreshold();
  return null;
}

let container: HTMLElement | null = null;
let root: Root | null = null;

function setup(url = "/stables") {
  window.history.replaceState(window.history.state, "", url);
  mockSearchParams = new URLSearchParams(window.location.search);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function renderHook(): ResultRef {
  const ref: ResultRef = { current: null };
  act(() => {
    root?.render(<HookWrapper resultRef={ref} />);
  });
  return ref;
}

function teardown() {
  if (!root || !container) return;
  act(() => {
    root?.unmount();
  });
  container.remove();
  root = null;
  container = null;
}

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
});

afterEach(() => {
  teardown();
});

describe("useSupplyChangeThreshold", () => {
  it("reads a direct-load USD threshold", () => {
    setup("/stables?minSupplyChangeUsd=2.5");
    const ref = renderHook();

    expect(ref.current?.minimumUsdValue).toBe(2.5);
  });

  it("writes non-default threshold state with replaceState", () => {
    setup("/stables?foo=1#changes");
    const ref = renderHook();

    act(() => {
      ref.current?.updateMinimumUsdValue(10);
    });

    expect(ref.current?.minimumUsdValue).toBe(10);
    expect(window.location.pathname).toBe("/stables");
    expect(window.location.search).toBe("?foo=1&minSupplyChangeUsd=10");
    expect(window.location.hash).toBe("#changes");
  });

  it("removes the URL param when reset to the default threshold", () => {
    setup("/stables?minSupplyChangeUsd=10&foo=1");
    const ref = renderHook();

    act(() => {
      ref.current?.resetMinimumUsdValue();
    });

    expect(ref.current?.minimumUsdValue).toBe(0.01);
    expect(window.location.search).toBe("?foo=1");
  });

  it("canonicalizes invalid threshold params on mount", () => {
    setup("/stables?minSupplyChangeUsd=-1&foo=1");
    const ref = renderHook();

    expect(ref.current?.minimumUsdValue).toBe(0.01);
    expect(window.location.search).toBe("?foo=1");
  });

  it("canonicalizes oversized threshold params on mount", () => {
    setup("/stables?minSupplyChangeUsd=1e21&foo=1");
    const ref = renderHook();

    expect(ref.current?.minimumUsdValue).toBe(MAX_SUPPLY_CHANGE_MIN_USD);
    expect(window.location.search).toBe(
      `?minSupplyChangeUsd=${MAX_SUPPLY_CHANGE_MIN_USD}&foo=1`,
    );
  });

  it("syncs state from browser back-forward popstate", () => {
    setup("/stables?minSupplyChangeUsd=10");
    const ref = renderHook();

    window.history.replaceState(window.history.state, "", "/stables");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(ref.current?.minimumUsdValue).toBe(0.01);
  });
});
