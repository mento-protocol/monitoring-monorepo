/** @vitest-environment jsdom */

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlotlyIdlePreloadScheduler,
  PlotlyIdlePreloader,
} from "@/components/plotly-idle-preloader";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let container: HTMLDivElement;
let root: Root | null;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
  previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT =
    previousActEnvironment ?? false;
});

describe("PlotlyIdlePreloader", () => {
  it("does no SSR work and invokes the idle import once across remounts", () => {
    let idleCallback: (() => void) | null = null;
    const requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);

    const loadPlotly = vi.fn(() => Promise.resolve());
    const schedule = createPlotlyIdlePreloadScheduler(loadPlotly);

    expect(
      renderToStaticMarkup(<PlotlyIdlePreloader schedule={schedule} />),
    ).toBe("");
    expect(requestIdleCallback).not.toHaveBeenCalled();

    root = createRoot(container);
    act(() => {
      root?.render(
        <StrictMode>
          <PlotlyIdlePreloader schedule={schedule} />
        </StrictMode>,
      );
    });
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 1_500,
    });

    act(() => root?.unmount());
    root = createRoot(container);
    act(() => {
      root?.render(<PlotlyIdlePreloader schedule={schedule} />);
    });
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);

    act(() => idleCallback?.());
    expect(loadPlotly).toHaveBeenCalledTimes(1);
  });

  it("uses the 1500ms timeout fallback when requestIdleCallback is absent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const loadPlotly = vi.fn(() => Promise.resolve());
    const schedule = createPlotlyIdlePreloadScheduler(loadPlotly);

    schedule();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(loadPlotly).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(loadPlotly).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected chunk import", async () => {
    const idleCallbackRef: { current: (() => void) | null } = {
      current: null,
    };
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        idleCallbackRef.current = callback;
        return 1;
      }),
    );
    const loadPlotly = vi.fn(() =>
      Promise.reject(new Error("plotly chunk unavailable")),
    );
    const onUnhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    const schedule = createPlotlyIdlePreloadScheduler(loadPlotly);

    schedule();
    idleCallbackRef.current?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(loadPlotly).toHaveBeenCalledTimes(1);
    expect(onUnhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  });
});
