import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H,
  POOL_DETAIL_WITH_HEALTH,
  POOL_THRESHOLDS_KNOWN_EXT,
  POOL_V2_EXCHANGE,
  POOL_VP_DEPRECATION_EXT,
  POOL_VP_LIFECYCLE_DEPRECATION_EXT,
  POOL_VP_ORACLE_FRESHNESS_EXT,
} from "@/lib/queries";
import { HASURA_TIMEOUT_MS } from "@/lib/hasura-timeout";

const requestMock = vi.fn();
const makeOgGraphQLClientMock = vi.fn((network: unknown) => {
  void network;
  return { request: requestMock };
});

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/og-graphql-client", () => ({
  makeOgGraphQLClient: (network: unknown) => makeOgGraphQLClientMock(network),
}));

vi.mock("@/lib/networks", () => ({
  NETWORKS: {
    "celo-mainnet": {
      id: "celo-mainnet",
      hasuraUrl: "https://example.com/v1/graphql",
    },
  },
  configuredNetworkIdForChainId: (chainId: number) =>
    chainId === 42220 ? "celo-mainnet" : null,
}));

import { fetchPoolDetailForSSR } from "../pool-detail-ssr";

const V2_EXCHANGE_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const VIRTUAL_POOL = {
  id: "42220-0xpool",
  chainId: 42220,
  token0: "0xt0",
  token1: "0xt1",
  source: "virtual_pool",
  wrappedExchangeId: V2_EXCHANGE_ID,
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
};
const V2_EXCHANGE_RESPONSE = {
  BiPoolExchange: [
    {
      id: `42220-${V2_EXCHANGE_ID}`,
      chainId: 42220,
      exchangeId: V2_EXCHANGE_ID,
      exchangeProvider: "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901",
      asset0: "0xt0",
      asset1: "0xt1",
      pricingModule: "0xpricingmodule",
      pricingModuleName: "ConstantSum",
      spread: "5000000000000000000000",
      referenceRateFeedID: "0xfeed000000000000000000000000000000000000",
      referenceRateResetFrequency: "300",
      minimumReports: "1",
      stablePoolResetSize: "1000000000000000000000",
      bucket0: "1000000000000000000000",
      bucket1: "2000000000000000000000",
      lastBucketUpdate: "1700000000",
      isDeprecated: false,
      wrappedByPoolId: VIRTUAL_POOL.id,
    },
  ],
};

describe("fetchPoolDetailForSSR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefetches split pool-detail extensions with timeout-bound requests", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    requestMock.mockImplementation(({ document }: { document: string }) => {
      if (document === POOL_DETAIL_WITH_HEALTH) {
        return { Pool: [VIRTUAL_POOL] };
      }
      if (document === POOL_THRESHOLDS_KNOWN_EXT) {
        return {
          Pool: [
            {
              id: VIRTUAL_POOL.id,
              rebalanceThresholdsKnown: true,
              tokenDecimalsKnown: true,
            },
          ],
        };
      }
      if (document === POOL_VP_ORACLE_FRESHNESS_EXT) {
        return { Pool: [{ id: VIRTUAL_POOL.id, medianLive: true }] };
      }
      if (document === POOL_VP_DEPRECATION_EXT) {
        return { BiPoolExchange: [{ id: "v2", minimumReports: "1" }] };
      }
      if (document === POOL_VP_LIFECYCLE_DEPRECATION_EXT) {
        return { VirtualPoolLifecycle: [] };
      }
      if (document === POOL_V2_EXCHANGE) {
        return V2_EXCHANGE_RESPONSE;
      }
      if (document === BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H) {
        return {
          BrokerExchangeDailySnapshot: [
            {
              id: "42220-v2-volume-1778457600",
              timestamp: "1778457600",
              volumeUsdWei: "42000000000000000000",
              swapCount: 3,
            },
          ],
        };
      }
      throw new Error("unexpected query");
    });

    const result = await fetchPoolDetailForSSR(42220, VIRTUAL_POOL.id);

    expect(result?.pool).toEqual({ Pool: [VIRTUAL_POOL] });
    expect(result?.thresholds?.Pool[0]?.tokenDecimalsKnown).toBe(true);
    expect(result?.vpOracleFreshness?.Pool[0]?.medianLive).toBe(true);
    expect(result?.vpDeprecation?.BiPoolExchange[0]?.minimumReports).toBe("1");
    expect(result?.vpLifecycleDeprecation?.VirtualPoolLifecycle).toEqual([]);
    expect(result?.v2Exchange).toEqual(V2_EXCHANGE_RESPONSE);
    expect(
      result?.brokerExchange24h?.BrokerExchangeDailySnapshot[0],
    ).toMatchObject({
      volumeUsdWei: "42000000000000000000",
      swapCount: 3,
    });
    expect(requestMock).toHaveBeenCalledTimes(7);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(HASURA_TIMEOUT_MS);
    const signals = requestMock.mock.calls.map(([request]) => {
      return (request as { signal: AbortSignal }).signal;
    });
    expect(new Set(signals).size).toBe(1);
  });

  it("keeps sibling fallback data when an extension query fails", async () => {
    requestMock.mockImplementation(({ document }: { document: string }) => {
      if (document === POOL_DETAIL_WITH_HEALTH) {
        return { Pool: [VIRTUAL_POOL] };
      }
      if (document === POOL_THRESHOLDS_KNOWN_EXT) {
        throw new Error("field rebalanceThresholdsKnown not found");
      }
      if (document === POOL_VP_ORACLE_FRESHNESS_EXT) {
        return { Pool: [{ id: VIRTUAL_POOL.id, medianLive: true }] };
      }
      if (document === POOL_VP_DEPRECATION_EXT) {
        return { BiPoolExchange: [] };
      }
      if (document === POOL_VP_LIFECYCLE_DEPRECATION_EXT) {
        return { VirtualPoolLifecycle: [] };
      }
      if (document === POOL_V2_EXCHANGE) {
        return V2_EXCHANGE_RESPONSE;
      }
      if (document === BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H) {
        return { BrokerExchangeDailySnapshot: [] };
      }
      throw new Error("unexpected query");
    });

    const result = await fetchPoolDetailForSSR(42220, VIRTUAL_POOL.id);

    expect(result?.pool).toEqual({ Pool: [VIRTUAL_POOL] });
    expect(result?.thresholds).toBeUndefined();
    expect(result?.vpOracleFreshness?.Pool[0]?.medianLive).toBe(true);
    expect(result?.v2Exchange).toEqual(V2_EXCHANGE_RESPONSE);
    expect(result?.brokerExchange24h?.BrokerExchangeDailySnapshot).toEqual([]);
  });
});
