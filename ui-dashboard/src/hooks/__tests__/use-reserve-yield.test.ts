/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ReserveYieldResponse } from "@/lib/reserve-yield";
import { rateLimitAwareRetry } from "@/lib/gql-retry";

type ReserveYieldSWRConfig = {
  refreshInterval: number;
  revalidateOnFocus: boolean;
  revalidateOnReconnect: boolean;
  refreshWhenHidden: boolean;
  errorRetryCount: number;
  onErrorRetry: unknown;
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wires the shared active-tab retry guard", () => {
    const { config } = renderReserveYieldProbe();

    expect(config.revalidateOnFocus).toBe(false);
    expect(config.revalidateOnReconnect).toBe(false);
    expect(config.refreshWhenHidden).toBe(false);
    expect(config.errorRetryCount).toBe(5);
    expect(config.onErrorRetry).toBe(rateLimitAwareRetry);
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
