import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientError, GraphQLClient } from "@/lib/graphql-fetch";
import type { NetworkData } from "@/lib/fetch-all-networks";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import type {
  LivePoolHealthRow,
  LivePoolHealthSlice,
} from "../use-live-pool-health";

const swrMock = vi.hoisted(() => ({
  result: {
    data: undefined as LivePoolHealthSlice[] | undefined,
    error: undefined as Error | undefined,
    isLoading: true,
  },
  config: undefined as Record<string, unknown> | undefined,
  fetcher: undefined as (() => Promise<LivePoolHealthSlice[]>) | undefined,
}));
const cacheMock = vi.hoisted(() => ({
  data: undefined as LivePoolHealthSlice[] | undefined,
}));

vi.mock("swr", () => ({
  default: (
    _key: string,
    fetcher: () => Promise<LivePoolHealthSlice[]>,
    config: Record<string, unknown>,
  ) => {
    swrMock.fetcher = fetcher;
    swrMock.config = config;
    return swrMock.result;
  },
  useSWRConfig: () => ({
    cache: {
      get: () =>
        cacheMock.data === undefined ? undefined : { data: cacheMock.data },
    },
  }),
}));

vi.mock("@/lib/networks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/networks")>();
  return {
    ...actual,
    NETWORK_IDS: ["celo-mainnet"],
    NETWORKS: {
      ...actual.NETWORKS,
      "celo-mainnet": {
        ...actual.NETWORKS["celo-mainnet"],
        hasuraUrl: "https://example.test/graphql",
      },
    },
    isConfiguredNetworkId: (id: string) => id === "celo-mainnet",
  };
});

import { useLivePoolHealth } from "../use-live-pool-health";

const BASE_POOL = {
  id: "pool-1",
  chainId: 42220,
  token0: "0xtoken0",
  token1: "0xtoken1",
  source: "fpmm_factory",
  createdAtBlock: "1",
  createdAtTimestamp: "1000",
  updatedAtBlock: "2",
  updatedAtTimestamp: "2000",
  oracleOk: true,
  oracleTimestamp: "1900",
  oracleFreshnessCheckedAt: 2_000,
  priceDifference: "0",
} satisfies Pool;

const NETWORK_DATA = {
  network: { id: "celo-mainnet" } as Network,
  pools: [BASE_POOL],
} as NetworkData;
const NETWORK_DATA_ARRAY = [NETWORK_DATA];

const LIVE_ROW = {
  id: BASE_POOL.id,
  updatedAtBlock: "3",
  updatedAtTimestamp: "2100",
  oracleOk: false,
  oracleTimestamp: "2050",
  oracleExpiry: "300",
  oracleNumReporters: 3,
  priceDifference: "0",
  rebalanceThreshold: 5000,
  rebalanceThresholdAbove: 5000,
  rebalanceThresholdBelow: 5000,
  rebalanceThresholdsKnown: true,
  tokenDecimalsKnown: true,
  degenerateReserves: false,
  breakerTripped: false,
  deviationBreachStartedAt: "0",
  lastRebalancedAt: "2000",
  hasHealthData: true,
  limitStatus: "OK",
  limitPressure0: "0",
  limitPressure1: "0",
  medianLive: true,
  oracleFreshnessWindow: "0",
  oracleFreshnessCheckedAt: 2_100,
} satisfies LivePoolHealthRow;

let observed: ReturnType<typeof useLivePoolHealth> | undefined;

function Probe() {
  observed = useLivePoolHealth(NETWORK_DATA_ARRAY);
  return null;
}

describe("useLivePoolHealth", () => {
  beforeEach(() => {
    swrMock.result = {
      data: undefined,
      error: undefined,
      isLoading: true,
    };
    swrMock.config = undefined;
    swrMock.fetcher = undefined;
    cacheMock.data = undefined;
    observed = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses a bounded 30s poll with focus, reconnect, and hidden refreshes disabled", () => {
    renderToStaticMarkup(<Probe />);

    expect(swrMock.fetcher).toEqual(expect.any(Function));
    expect(swrMock.config).toMatchObject({
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
    });
  });

  it("surfaces a failed refresh while continuing to render retained live rows", () => {
    const refreshError = new Error("health timeout");
    swrMock.result = {
      data: [
        {
          networkId: "celo-mainnet",
          pools: [LIVE_ROW],
          error: refreshError,
        },
      ],
      error: undefined,
      isLoading: false,
    };

    renderToStaticMarkup(<Probe />);

    expect(observed?.networkData[0]?.pools[0]).toMatchObject({
      oracleOk: false,
      oracleTimestamp: "2050",
      oracleFreshnessCheckedAt: 2_100,
    });
    expect(observed?.networkData[0]?.liveHealthError).toEqual({
      message: "health timeout",
    });
    expect(observed?.error).toBe(refreshError);
  });

  it("keeps a newer equal-block live observation across a remount", async () => {
    vi.spyOn(GraphQLClient.prototype, "request").mockResolvedValue({
      Pool: [{ ...LIVE_ROW, updatedAtBlock: BASE_POOL.updatedAtBlock }],
    });
    renderToStaticMarkup(<Probe />);
    const liveSlices = await swrMock.fetcher!();
    cacheMock.data = liveSlices;
    swrMock.result = {
      data: liveSlices,
      error: undefined,
      isLoading: false,
    };

    // New renderToStaticMarkup call = a new hook instance, mirroring page
    // navigation while both SWR cache entries retain their identities.
    renderToStaticMarkup(<Probe />);

    expect(observed?.networkData[0]?.pools[0]).toMatchObject({
      oracleOk: false,
      oracleTimestamp: LIVE_ROW.oracleTimestamp,
    });
  });

  it("honors Retry-After per network after a resolved partial 429 result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const rateLimitError = new ClientError(
      {
        status: 429,
        headers: new Headers({ "retry-after": "300" }),
        body: "",
      },
      { query: "query AllPoolsLiveHealth { Pool { id } }" },
    );
    const request = vi
      .spyOn(GraphQLClient.prototype, "request")
      .mockRejectedValue(rateLimitError);
    renderToStaticMarkup(<Probe />);

    const first = await swrMock.fetcher!();
    cacheMock.data = first;
    const callsAfterFirstAttempt = request.mock.calls.length;
    expect(callsAfterFirstAttempt).toBeGreaterThan(0);

    vi.advanceTimersByTime(30_000);
    // A navigation remount creates a new hook/fetcher. Retry-After must be
    // shared at the same scope as the SWR cache, not forgotten with the old
    // component instance.
    renderToStaticMarkup(<Probe />);
    await swrMock.fetcher!();
    expect(request).toHaveBeenCalledTimes(callsAfterFirstAttempt);

    vi.advanceTimersByTime(270_001);
    await swrMock.fetcher!();
    expect(request.mock.calls.length).toBeGreaterThan(callsAfterFirstAttempt);
  });
});
