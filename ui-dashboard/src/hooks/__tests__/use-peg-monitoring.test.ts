/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEG_MONITORING_REFRESH_MS } from "@/lib/peg-monitoring";
import { SWR_KEY_PEG_MONITORING } from "@/lib/swr-keys";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
const swr = vi.hoisted(() => vi.fn());
vi.mock("swr", () => ({ default: swr }));
import { usePegMonitoring } from "../use-peg-monitoring";
let result: ReturnType<typeof usePegMonitoring> | null = null;
let mountedRoot: ReturnType<typeof createRoot> | null = null;
function Probe(): null {
  result = usePegMonitoring();
  return null;
}
function render(): {
  fetcher: () => Promise<unknown>;
  config: Record<string, unknown>;
} {
  mountedRoot = createRoot(document.createElement("div"));
  act(() => mountedRoot?.render(createElement(Probe)));
  const call = swr.mock.calls[0]!;
  return {
    fetcher: call[1] as () => Promise<unknown>,
    config: call[2] as Record<string, unknown>,
  };
}
beforeEach(() => {
  swr.mockReset();
  swr.mockReturnValue({ data: undefined, error: undefined, isLoading: true });
  result = null;
});
afterEach(() => {
  if (mountedRoot !== null) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
});
describe("usePegMonitoring", () => {
  it("uses the same-origin polling and resumed-tab refresh contract", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(makePegMonitoringResponse()));
    const probe = render();
    expect(swr.mock.calls[0]?.[0]).toBe(SWR_KEY_PEG_MONITORING);
    expect(probe.config).toMatchObject({
      refreshInterval: PEG_MONITORING_REFRESH_MS,
      revalidateOnFocus: true,
      focusThrottleInterval: PEG_MONITORING_REFRESH_MS,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
    });
    expect(probe.config).not.toHaveProperty("onError");
    await expect(probe.fetcher()).resolves.toEqual(makePegMonitoringResponse());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/peg-monitoring");
  });
  it("waits for two consecutive refresh failures before degrading retained data", () => {
    const data = makePegMonitoringResponse();
    const error = new Error("503");
    swr.mockReturnValue({ data, error, isLoading: false });
    const probe = render();
    const onErrorRetry = probe.config.onErrorRetry as (
      cause: Error,
      key: string,
      config: { errorRetryCount: number },
      revalidate: () => void,
      options: { retryCount: number; dedupe: boolean },
    ) => void;
    const onSuccess = probe.config.onSuccess as (response: unknown) => void;
    const recordFailure = () =>
      onErrorRetry(
        error,
        SWR_KEY_PEG_MONITORING,
        { errorRetryCount: 0 },
        vi.fn(),
        {
          retryCount: 1,
          dedupe: true,
        },
      );

    expect(result).toEqual({ data, hasError: false, isLoading: false });
    act(recordFailure);
    expect(result).toEqual({ data, hasError: false, isLoading: false });
    act(recordFailure);
    expect(result).toEqual({ data, hasError: true, isLoading: false });
    act(() => onSuccess(data));
    expect(result).toEqual({ data, hasError: false, isLoading: false });
  });
});
