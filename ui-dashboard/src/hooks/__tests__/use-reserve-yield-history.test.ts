/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitAwareRetry } from "@/lib/gql-retry";
import type {
  ReserveYieldDailySnapshotRow,
  StethYieldDailySnapshotRow,
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
  stethHistoryFailed: boolean;
  hasStethSnapshotSource: boolean;
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
    token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
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

function stethSnapshot(): StethYieldDailySnapshotRow {
  return {
    id: "1-steth-0xreserve-1772668800",
    chainId: 1,
    token: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    wallet: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
    timestamp: "1772668800",
    balanceAmount: "1000000000000000000",
    principalAmount: "900000000000000000",
    realizedYieldAmount: "0",
    transferredOutYieldAmount: "0",
    unrealizedYieldAmount: "100000000000000000",
    totalEarnedYieldAmount: "100000000000000000",
    dailyEarnedYieldAmount: "1000000000000000",
    dailyRealizedYieldAmount: "0",
    dailyUnrealizedYieldAmount: "1000000000000000",
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
        stethHistoryFailed: false,
        hasStethSnapshotSource: false,
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
      stethHistoryFailed: false,
      hasStethSnapshotSource: false,
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
      stethHistoryFailed: true,
      hasStethSnapshotSource: false,
    });
    expect(graphQlRequestMock).toHaveBeenCalledTimes(2);
  });

  it("tracks an empty stETH response separately from a request failure", async () => {
    const snapshot = reserveSnapshot();
    graphQlRequestMock
      .mockResolvedValueOnce({ SusdsYieldDailySnapshot: [snapshot] })
      .mockResolvedValueOnce({ StethYieldDailySnapshot: [] });

    const { fetcher } = renderReserveYieldHistoryProbe();

    await expect(fetcher()).resolves.toEqual({
      rows: [snapshot],
      unavailable: false,
      truncated: false,
      stethHistoryFailed: false,
      hasStethSnapshotSource: false,
    });
  });

  it("reports a valid stETH snapshot source independently of sUSDS", async () => {
    const susds = reserveSnapshot();
    const steth = stethSnapshot();
    graphQlRequestMock
      .mockResolvedValueOnce({ SusdsYieldDailySnapshot: [susds] })
      .mockResolvedValueOnce({ StethYieldDailySnapshot: [steth] });

    const { fetcher } = renderReserveYieldHistoryProbe();

    await expect(fetcher()).resolves.toEqual({
      rows: [susds, steth],
      unavailable: false,
      truncated: false,
      stethHistoryFailed: false,
      hasStethSnapshotSource: true,
    });
  });

  it("keeps sUSDS rows and marks malformed stETH history as failed", async () => {
    const susds = reserveSnapshot();
    graphQlRequestMock
      .mockResolvedValueOnce({ SusdsYieldDailySnapshot: [susds] })
      .mockResolvedValueOnce({
        StethYieldDailySnapshot: [
          { ...stethSnapshot(), totalEarnedYieldAmount: "invalid" },
        ],
      });

    const { fetcher } = renderReserveYieldHistoryProbe();

    await expect(fetcher()).resolves.toEqual({
      rows: [susds],
      unavailable: false,
      truncated: false,
      stethHistoryFailed: true,
      hasStethSnapshotSource: false,
    });
  });

  it.each([
    ["negative chain", { chainId: -1 }],
    ["wrong chain", { chainId: 137 }],
    ["wrong token", { token: "0x0000000000000000000000000000000000000001" }],
    [
      "untracked wallet",
      { wallet: "0x0000000000000000000000000000000000000002" },
    ],
    ["zero timestamp", { timestamp: "0" }],
    ["negative balance", { balanceAmount: "-1" }],
    ["negative principal", { principalAmount: "-1" }],
    ["negative transferred yield", { transferredOutYieldAmount: "-1" }],
    ["negative daily earned yield", { dailyEarnedYieldAmount: "-1" }],
    ["negative daily realized yield", { dailyRealizedYieldAmount: "-1" }],
    ["zero sampled block", { sampledAtBlock: "0" }],
    ["negative sampled timestamp", { sampledAtTimestamp: "-1" }],
  ])("rejects a stETH row with %s", async (_label, overrides) => {
    const susds = reserveSnapshot();
    graphQlRequestMock
      .mockResolvedValueOnce({ SusdsYieldDailySnapshot: [susds] })
      .mockResolvedValueOnce({
        StethYieldDailySnapshot: [{ ...stethSnapshot(), ...overrides }],
      });

    const { fetcher } = renderReserveYieldHistoryProbe();

    await expect(fetcher()).resolves.toMatchObject({
      rows: [susds],
      stethHistoryFailed: true,
      hasStethSnapshotSource: false,
    });
  });

  it("accepts a signed stETH daily unrealized compression delta", async () => {
    const susds = reserveSnapshot();
    const steth = stethSnapshot();
    graphQlRequestMock
      .mockResolvedValueOnce({ SusdsYieldDailySnapshot: [susds] })
      .mockResolvedValueOnce({
        StethYieldDailySnapshot: [
          {
            ...steth,
            dailyUnrealizedYieldAmount: "-1",
          },
        ],
      });

    const { fetcher } = renderReserveYieldHistoryProbe();

    await expect(fetcher()).resolves.toMatchObject({
      stethHistoryFailed: false,
      hasStethSnapshotSource: true,
    });
  });

  it("accepts configured stETH identity fields case-insensitively", async () => {
    const susds = reserveSnapshot();
    graphQlRequestMock
      .mockResolvedValueOnce({ SusdsYieldDailySnapshot: [susds] })
      .mockResolvedValueOnce({
        StethYieldDailySnapshot: [
          {
            ...stethSnapshot(),
            token: "0xAE7AB96520DE3A18E5E111B5EAAB095312D7FE84",
            wallet: "0xD0697F70E79476195B742D5AFAB14BE50F98CC1E",
          },
        ],
      });

    const { fetcher } = renderReserveYieldHistoryProbe();

    await expect(fetcher()).resolves.toMatchObject({
      stethHistoryFailed: false,
      hasStethSnapshotSource: true,
    });
  });

  it.each([
    ["totalEarnedYieldUsdWei", "invalid"],
    ["dailyEarnedYieldUsdWei", undefined],
  ] as const)(
    "fails the history fetch closed when an sUSDS row has invalid %s",
    async (field, value) => {
      graphQlRequestMock.mockResolvedValueOnce({
        SusdsYieldDailySnapshot: [
          {
            ...reserveSnapshot(),
            [field]: value,
          },
        ],
      });

      const { fetcher } = renderReserveYieldHistoryProbe();

      await expect(fetcher()).rejects.toThrow(
        "SusdsYieldDailySnapshot contained a malformed row",
      );
      expect(graphQlRequestMock).toHaveBeenCalledTimes(1);
    },
  );

  it("suppresses a malformed sUSDS row restored from the SWR cache", () => {
    swrMock.mockReturnValue({
      data: {
        rows: [
          {
            ...reserveSnapshot(),
            totalEarnedYieldUsdWei: "invalid",
          },
        ],
        unavailable: false,
        truncated: false,
        stethHistoryFailed: false,
        hasStethSnapshotSource: false,
      },
      error: undefined,
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

  it("drops malformed cached stETH rows without discarding cached sUSDS", () => {
    const susds = reserveSnapshot();
    swrMock.mockReturnValue({
      data: {
        rows: [
          susds,
          { ...stethSnapshot(), dailyEarnedYieldAmount: "invalid" },
        ],
        unavailable: false,
        truncated: false,
        stethHistoryFailed: false,
        hasStethSnapshotSource: true,
      },
      error: undefined,
      isLoading: false,
    });

    const { result } = renderReserveYieldHistoryProbe();

    expect(result).toMatchObject({
      rows: [susds],
      hasError: false,
      stethHistoryFailed: true,
      hasStethSnapshotSource: false,
    });
  });
});
