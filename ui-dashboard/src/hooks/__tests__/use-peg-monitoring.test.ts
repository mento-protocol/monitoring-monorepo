/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PEG_MONITORING_REFRESH_MS } from "@/lib/peg-monitoring";
import { SWR_KEY_PEG_MONITORING } from "@/lib/swr-keys";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
const swr = vi.hoisted(() => vi.fn());
vi.mock("swr", () => ({ default: swr }));
import { usePegMonitoring } from "../use-peg-monitoring";
let result: ReturnType<typeof usePegMonitoring> | null = null;
function Probe(): null {
  result = usePegMonitoring();
  return null;
}
function render(): {
  fetcher: () => Promise<unknown>;
  config: Record<string, unknown>;
} {
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
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
describe("usePegMonitoring", () => {
  it("uses the same-origin timed 30-second polling contract", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(makePegMonitoringResponse()));
    const probe = render();
    expect(swr.mock.calls[0]?.[0]).toBe(SWR_KEY_PEG_MONITORING);
    expect(probe.config).toMatchObject({
      refreshInterval: PEG_MONITORING_REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
    });
    await expect(probe.fetcher()).resolves.toEqual(makePegMonitoringResponse());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/peg-monitoring");
  });
  it("retains confirmed data when refresh fails", () => {
    const data = makePegMonitoringResponse();
    swr.mockReturnValue({ data, error: new Error("503"), isLoading: false });
    render();
    expect(result).toEqual({ data, hasError: true, isLoading: false });
  });
});
