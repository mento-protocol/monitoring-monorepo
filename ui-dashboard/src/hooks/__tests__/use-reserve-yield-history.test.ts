/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import type {
  ReserveYieldDailySnapshotRow,
  SusdsYieldDailySnapshotRow,
} from "@/lib/canonical-revenue";

type ReserveYieldHistorySWRConfig = {
  refreshInterval: number;
  revalidateOnFocus: boolean;
  revalidateOnReconnect: boolean;
  refreshWhenHidden: boolean;
  onErrorRetry: unknown;
};

type ReserveYieldHistoryFetcher = () => Promise<{
  rows: ReserveYieldDailySnapshotRow[];
  unavailable: boolean;
  truncated: boolean;
}>;

const swrMock = vi.hoisted(() => vi.fn());
const graphQlRequestMock = vi.hoisted(() => vi.fn());

vi.mock("swr", () => ({
  default: swrMock,
}));

vi.mock("@/lib/graphql-fetch", () => ({
  GraphQLClient: vi.fn().mockImplementation(function GraphQLClient() {
    return {
      request: graphQlRequestMock,
    };
  }),
}));

vi.mock("@/lib/networks", () => ({
  NETWORKS: {
    "celo-mainnet": {
      hasuraUrl: "https://hasura.test/v1/graphql",
    },
  },
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
  fetcher: ReserveYieldHistoryFetcher;
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
  const fetcher = swrMock.mock.calls[0]?.[1] as
    | ReserveYieldHistoryFetcher
    | undefined;
  if (config === undefined) throw new Error("SWR config was not captured");
  if (fetcher === undefined) throw new Error("SWR fetcher was not captured");
  if (capturedResult === null) {
    throw new Error("Reserve yield history hook result was not captured");
  }
  return { config, fetcher, result: capturedResult };
}

describe("useReserveYieldHistory", () => {
  beforeEach(() => {
    swrMock.mockReset();
    graphQlRequestMock.mockReset();
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

  it("keeps sUSDS rows when the optional stETH history request fails", async () => {
    const snapshot = reserveSnapshot();
    graphQlRequestMock
      .mockResolvedValueOnce({ SusdsYieldDailySnapshot: [snapshot] })
      .mockRejectedValueOnce(new Error("temporary stETH failure"));

    const { fetcher } = renderReserveYieldHistoryProbe();

    await expect(fetcher()).resolves.toEqual({
      rows: [snapshot],
      unavailable: false,
      truncated: false,
    });
    expect(graphQlRequestMock).toHaveBeenCalledTimes(2);
  });
});
