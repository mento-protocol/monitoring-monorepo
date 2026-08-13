/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import { PEG_HISTORY_RANGES, type PegHistoryResponse } from "@/lib/peg-history";

const swr = vi.hoisted(() => vi.fn());
vi.mock("swr", () => ({ default: swr }));

import {
  pegHistoryUrl,
  usePegHistory,
  type PegHistoryIdentity,
} from "../use-peg-history";

const identity: PegHistoryIdentity = {
  asset: "europ-schuman",
  source: "bitvavo_eur",
  policyVersion: "europ-v1",
};
const data: PegHistoryResponse = {
  ...identity,
  range: "7d",
  from: 1_786_000_000,
  to: 1_786_604_800,
  stepSeconds: 1_800,
  points: [{ at: 1_786_604_800, bps: -3 }],
};

let selectedIdentity: PegHistoryIdentity | null = identity;
let result: ReturnType<typeof usePegHistory> | null = null;

function Probe(): null {
  result = usePegHistory(selectedIdentity, "7d");
  return null;
}

function render(): {
  key: string | null;
  fetcher: (url: string) => Promise<PegHistoryResponse>;
  config: Record<string, unknown>;
} {
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  const call = swr.mock.calls[0]!;
  return {
    key: call[0] as string | null,
    fetcher: call[1] as (url: string) => Promise<PegHistoryResponse>,
    config: call[2] as Record<string, unknown>,
  };
}

beforeEach(() => {
  swr.mockReset();
  swr.mockReturnValue({ data: undefined, error: undefined, isLoading: true });
  selectedIdentity = identity;
  result = null;
});

describe("usePegHistory", () => {
  it("uses one bounded same-origin key and the shared active-tab retry guard", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(data));
    const probe = render();
    expect(probe.key).toBe(
      "/api/peg-monitoring/history?asset=europ-schuman&source=bitvavo_eur&policyVersion=europ-v1&range=7d",
    );
    expect(probe.config).toMatchObject({
      refreshInterval: PEG_HISTORY_RANGES["7d"].stepSeconds * 1_000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      onErrorRetry: rateLimitAwareRetry,
    });
    await expect(probe.fetcher(probe.key!)).resolves.toEqual(data);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(probe.key);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("does not query without a complete current-state identity", () => {
    selectedIdentity = null;
    const probe = render();
    expect(probe.key).toBeNull();
    expect(result).toEqual({ data: null, hasError: false, isLoading: false });
  });

  it("reports a revalidation error alongside retained data", () => {
    swr.mockReturnValue({ data, error: new Error("503"), isLoading: false });
    render();
    expect(result).toEqual({ data, hasError: true, isLoading: false });
  });

  it("builds encoded keys instead of interpolating labels", () => {
    expect(
      pegHistoryUrl(
        { ...identity, policyVersion: "version with spaces" },
        "24h",
      ),
    ).toContain("policyVersion=version+with+spaces");
  });
});
