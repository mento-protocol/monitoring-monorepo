/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import {
  PEG_ALERTS_REFRESH_MS,
  type PegAlertsResponse,
} from "@/lib/peg-alerts";
import { SWR_KEY_PEG_ALERTS } from "@/lib/swr-keys";

const swr = vi.hoisted(() => vi.fn());
vi.mock("swr", () => ({ default: swr }));

import { usePegAlerts } from "../use-peg-alerts";

const data: PegAlertsResponse = {
  from: 1_786_000_000,
  to: 1_786_604_800,
  events: [],
};
let enabled = true;
let result: ReturnType<typeof usePegAlerts> | null = null;

function Probe(): null {
  result = usePegAlerts(enabled);
  return null;
}

function render(): {
  key: string | null;
  fetcher: () => Promise<PegAlertsResponse>;
  config: Record<string, unknown>;
} {
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  const call = swr.mock.calls[0]!;
  return {
    key: call[0] as string | null,
    fetcher: call[1] as () => Promise<PegAlertsResponse>,
    config: call[2] as Record<string, unknown>,
  };
}

beforeEach(() => {
  swr.mockReset();
  swr.mockReturnValue({ data: undefined, error: undefined, isLoading: true });
  enabled = true;
  result = null;
});

describe("usePegAlerts", () => {
  it("polls the isolated same-origin feed every five minutes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(data));
    const probe = render();
    expect(probe.key).toBe(SWR_KEY_PEG_ALERTS);
    expect(probe.config).toMatchObject({
      refreshInterval: PEG_ALERTS_REFRESH_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    });
    await expect(probe.fetcher()).resolves.toEqual(data);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/peg-monitoring/alerts");
  });

  it("does not query until the current board has a confirmed package", () => {
    enabled = false;
    const probe = render();
    expect(probe.key).toBeNull();
    expect(result).toEqual({ data: null, hasError: false, isLoading: false });
  });

  it("retains events while a refresh error marks only the strip unavailable", () => {
    swr.mockReturnValue({ data, error: new Error("502"), isLoading: false });
    render();
    expect(result).toEqual({ data, hasError: true, isLoading: false });
  });
});
