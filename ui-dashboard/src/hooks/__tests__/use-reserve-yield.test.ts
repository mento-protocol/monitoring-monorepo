/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";

type ReserveYieldRetryOptions = {
  retryCount: number;
};

type ReserveYieldSWRConfig = {
  refreshInterval: number;
  revalidateOnFocus: boolean;
  revalidateOnReconnect: boolean;
  refreshWhenHidden: boolean;
  onErrorRetry: (
    error: unknown,
    key: string,
    config: unknown,
    revalidate: (options: ReserveYieldRetryOptions) => void,
    options: ReserveYieldRetryOptions,
  ) => void;
};

const swrMock = vi.hoisted(() => vi.fn());

vi.mock("swr", () => ({
  default: swrMock,
}));

import { useReserveYield } from "../use-reserve-yield";

let capturedResult: ReturnType<typeof useReserveYield> | null = null;

function ReserveYieldProbe() {
  capturedResult = useReserveYield();
  return null;
}

function renderReserveYieldProbe(): {
  config: ReserveYieldSWRConfig;
  result: ReturnType<typeof useReserveYield>;
} {
  capturedResult = null;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ReserveYieldProbe));
  });
  root.unmount();
  const config = swrMock.mock.calls[0]?.[2] as
    | ReserveYieldSWRConfig
    | undefined;
  if (config === undefined) throw new Error("SWR config was not captured");
  if (capturedResult === null) {
    throw new Error("Reserve yield hook result was not captured");
  }
  return { config, result: capturedResult };
}

describe("useReserveYield", () => {
  beforeEach(() => {
    swrMock.mockReset();
    swrMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gates SWR error retries while the tab is hidden", () => {
    const { config } = renderReserveYieldProbe();
    const revalidate = vi.fn();
    vi.stubGlobal("document", { visibilityState: "hidden" });

    config.onErrorRetry(new Error("boom"), "key", {}, revalidate, {
      retryCount: 0,
    });
    vi.advanceTimersByTime(30_000);

    expect(config.revalidateOnFocus).toBe(false);
    expect(config.revalidateOnReconnect).toBe(false);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("schedules visible-tab retries with a small cap", () => {
    const { config } = renderReserveYieldProbe();
    const revalidate = vi.fn();
    vi.stubGlobal("document", { visibilityState: "visible" });

    config.onErrorRetry(new Error("boom"), "key", {}, revalidate, {
      retryCount: 2,
    });
    vi.advanceTimersByTime(3_999);
    expect(revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revalidate).toHaveBeenCalledWith({ retryCount: 2 });

    revalidate.mockClear();
    config.onErrorRetry(new Error("boom"), "key", {}, revalidate, {
      retryCount: 5,
    });
    vi.advanceTimersByTime(30_000);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("surfaces source errors in hasError", () => {
    swrMock.mockReturnValue({
      data: {
        holdingsError: null,
        rateError: "FRED FEDFUNDS: HTTP 503",
      } satisfies Partial<ReserveYieldResponse>,
      error: undefined,
      isLoading: false,
    });

    const { result } = renderReserveYieldProbe();
    expect(result).toMatchObject({
      hasError: true,
      isLoading: false,
    });
  });
});
