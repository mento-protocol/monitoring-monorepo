/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataFreshnessBanner } from "@/components/data-freshness-banner";
import {
  markSWRFreshnessCached,
  recordSWRFreshnessError,
  recordSWRFreshnessSuccess,
  registerSWRFreshnessKey,
  resetSWRFreshnessForTests,
} from "@/lib/swr-freshness";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const NOW = 1_767_225_600_000;

let container: HTMLDivElement;
let root: Root;
let cleanupFreshness: (() => void) | null = null;

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSWRFreshnessForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  cleanupFreshness?.();
  cleanupFreshness = null;
  resetSWRFreshnessForTests();
  container.remove();
  vi.useRealTimers();
});

function render() {
  act(() => {
    root.render(<DataFreshnessBanner />);
  });
}

describe("DataFreshnessBanner", () => {
  it("appears when an active polling key has last-good data and a failed refresh", () => {
    cleanupFreshness = registerSWRFreshnessKey("polling-key");
    recordSWRFreshnessSuccess("polling-key", { refreshInterval: 30_000 });
    render();
    expect(container.textContent).toBe("");

    act(() => {
      vi.setSystemTime(NOW + 5_000);
      recordSWRFreshnessError(new Error("429"), "polling-key", {
        refreshInterval: 30_000,
      });
    });

    expect(container.textContent).toContain("Latest refresh failed");
    expect(container.textContent).toContain("last-good data from 5s ago");
  });

  it("stays hidden when active polling data is only older than its refresh interval", () => {
    cleanupFreshness = registerSWRFreshnessKey("slow-key");
    recordSWRFreshnessSuccess("slow-key", { refreshInterval: 30_000 });
    render();

    act(() => {
      vi.setSystemTime(NOW + 40_000);
      vi.advanceTimersByTime(10_000);
    });

    expect(container.textContent).toBe("");
  });

  it("announces cached data until the first network success", () => {
    markSWRFreshnessCached("cached-key", NOW - 7_000);
    cleanupFreshness = registerSWRFreshnessKey("cached-key");
    render();

    expect(container.textContent).toContain("Showing cached data from 7s ago");
    expect(container.textContent).toContain("Refreshing…");

    act(() => {
      recordSWRFreshnessSuccess("cached-key", { refreshInterval: 30_000 });
    });
    expect(container.textContent).toBe("");
  });
});
