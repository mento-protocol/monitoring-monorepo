/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import type { SusdsYieldDailySnapshotRow } from "@/lib/canonical-revenue";

type ReserveYieldHistorySWRConfig = {
  refreshInterval: number;
  revalidateOnFocus: boolean;
  revalidateOnReconnect: boolean;
  refreshWhenHidden: boolean;
  onErrorRetry: unknown;
};

const swrMock = vi.hoisted(() => vi.fn());

vi.mock("swr", () => ({
  default: swrMock,
}));

import { useReserveYieldHistory } from "../use-reserve-yield-history";

let capturedResult: ReturnType<typeof useReserveYieldHistory> | null = null;

function reserveSnapshot(): SusdsYieldDailySnapshotRow {
  return {
    id: "1-susds-1772668800",
    chainId: 1,
    token: "0xsusds",
    timestamp: "1772668800",
    currentShares: "0",
    costBasisUsdWei: "0",
    realizedYieldUsdWei: "0",
    transferredOutYieldUsdWei: "0",
    redeemedYieldUsdWei: "0",
    currentValueUsdWei: "0",
    unrealizedYieldUsdWei: "0",
    totalEarnedYieldUsdWei: "0",
    dailyEarnedYieldUsdWei: "0",
    dailyRealizedYieldUsdWei: "0",
    dailyUnrealizedYieldUsdWei: "0",
    sharePriceUsdWei: "1000000000000000000",
    sampledAtBlock: "1",
    sampledAtTimestamp: "1772668800",
  };
}

function ReserveYieldHistoryProbe() {
  capturedResult = useReserveYieldHistory();
  return null;
}

function renderReserveYieldHistoryProbe(): {
  config: ReserveYieldHistorySWRConfig;
  result: ReturnType<typeof useReserveYieldHistory>;
} {
  capturedResult = null;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ReserveYieldHistoryProbe));
  });
  root.unmount();
  const config = swrMock.mock.calls[0]?.[2] as
    | ReserveYieldHistorySWRConfig
    | undefined;
  if (config === undefined) throw new Error("SWR config was not captured");
  if (capturedResult === null) {
    throw new Error("Reserve yield history hook result was not captured");
  }
  return { config, result: capturedResult };
}

describe("useReserveYieldHistory", () => {
  beforeEach(() => {
    swrMock.mockReset();
    swrMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it("wires the shared active-tab retry guard", () => {
    const { config } = renderReserveYieldHistoryProbe();

    expect(config.revalidateOnFocus).toBe(false);
    expect(config.revalidateOnReconnect).toBe(false);
    expect(config.refreshWhenHidden).toBe(false);
    expect(config.onErrorRetry).toBe(rateLimitAwareRetry);
  });

  it("suppresses stale rows when a revalidation error is present", () => {
    swrMock.mockReturnValue({
      data: {
        rows: [reserveSnapshot()],
        unavailable: true,
        truncated: true,
      },
      error: new Error("Hasura unavailable"),
      isLoading: false,
    });

    const { result } = renderReserveYieldHistoryProbe();

    expect(result).toMatchObject({
      rows: [],
      hasError: true,
      unavailable: false,
      truncated: false,
    });
  });
});
