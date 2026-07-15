import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H,
  POOL_BREAKER_CONFIG,
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

// Capture the key parts passed to `unstable_cache` at module init (mirrors
// network-fetcher server-cache.test.ts) so the deploy/endpoint salt can't
// silently disappear.
const { capturedCacheKeyParts } = vi.hoisted(() => ({
  capturedCacheKeyParts: [] as string[][],
}));
vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(
    fn: T,
    keyParts?: string[],
  ) => {
    if (keyParts) capturedCacheKeyParts.push(keyParts);
    return fn;
  },
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
  NETWORK_IDS: ["celo-mainnet"],
  isConfiguredNetworkId: (v: string) => v === "celo-mainnet",
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

const FX_FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const FPMM_POOL = {
  id: "42220-0xfpmm",
  chainId: 42220,
  token0: "0xt0",
  token1: "0xt1",
  source: "fpmm_factory",
  referenceRateFeedID: FX_FEED,
  createdAtBlock: "1",
  createdAtTimestamp: "1700000000",
  updatedAtBlock: "1",
  updatedAtTimestamp: "1700000000",
};
const BREAKER_CONFIG_RESPONSE = {
  BreakerConfig: [
    {
      id: "1",
      enabled: true,
      cooldownTime: "0",
      rateChangeThreshold: "0",
      smoothingFactor: "5000000000000000000000",
      medianRatesEMA: "1171560280196965000000000",
      referenceValue: null,
      lastMedianRate: "1175000000000000000000000",
      lastUpdatedAt: "1700000000",
      status: "OK",
      tradingMode: 0,
      lastStatusUpdatedAt: "1700000000",
      cooldownEndsAt: "0",
      lastTripAt: null,
      lastTripTxHash: null,
      lastResetAt: null,
      tripCountLifetime: 0,
      breaker: {
        id: "b",
        address: "0x49349f92d2b17d491e42c8fdb02d19f072f9b5d9",
        kind: "MEDIAN_DELTA",
        activatesTradingMode: 3,
        defaultCooldownTime: "900",
        defaultRateChangeThreshold: "40000000000000000000000",
      },
    },
  ],
  BreakerTripEvent: [],
};

const THRESHOLDS_RESPONSE = {
  Pool: [
    {
      id: VIRTUAL_POOL.id,
      rebalanceThresholdsKnown: true,
      tokenDecimalsKnown: true,
    },
  ],
};
const VP_FRESHNESS_RESPONSE = {
  Pool: [{ id: VIRTUAL_POOL.id, medianLive: true }],
};
const VP_DEPRECATION_RESPONSE = {
  BiPoolExchange: [{ id: "v2", minimumReports: "1" }],
};
const VP_LIFECYCLE_RESPONSE = { VirtualPoolLifecycle: [] };
const BROKER_24H_RESPONSE = {
  BrokerExchangeDailySnapshot: [
    {
      id: "42220-v2-volume-1778457600",
      timestamp: "1778457600",
      volumeUsdWei: "42000000000000000000",
      swapCount: 3,
    },
  ],
};

function validVirtualResponses(): Record<string, unknown> {
  return {
    [POOL_DETAIL_WITH_HEALTH]: { Pool: [VIRTUAL_POOL] },
    [POOL_THRESHOLDS_KNOWN_EXT]: THRESHOLDS_RESPONSE,
    [POOL_VP_ORACLE_FRESHNESS_EXT]: VP_FRESHNESS_RESPONSE,
    [POOL_VP_DEPRECATION_EXT]: VP_DEPRECATION_RESPONSE,
    [POOL_VP_LIFECYCLE_DEPRECATION_EXT]: VP_LIFECYCLE_RESPONSE,
    [POOL_V2_EXCHANGE]: V2_EXCHANGE_RESPONSE,
    [BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H]: BROKER_24H_RESPONSE,
  };
}

function respondByDocument(responses: Record<string, unknown>) {
  return ({ document }: { document: string }) => {
    if (!(document in responses)) throw new Error("unexpected query");
    const response = responses[document];
    if (response instanceof Error) throw response;
    return response;
  };
}

describe("fetchPoolDetailForSSR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("salts the SSR cache key with the deployment id AND the configured Hasura endpoint so a cross-deploy / endpoint switch can't serve the wrong provenance (Codex finding, Refs #1212)", () => {
    // Captured at module init by the next/cache mock. Vercel's Data Cache
    // persists across deploys within an environment, so an env-only redeploy
    // or a Hasura endpoint swap must produce a DIFFERENT key or first paint
    // could serve breaker/market-hours rows from the previous endpoint.
    expect(capturedCacheKeyParts).toHaveLength(1);
    const parts = capturedCacheKeyParts[0]!;
    expect(parts[0]).toBe("pool-detail-ssr");
    // Deploy salt: VERCEL_DEPLOYMENT_ID / _GIT_COMMIT_SHA in prod, "dev" here.
    expect(parts[1]).toBeTruthy();
    // Endpoint salt carries the configured chain's resolved Hasura URL.
    expect(parts[2]).toContain("https://example.com/v1/graphql");
    expect(parts).toHaveLength(3);

    // Non-collision: changing ONLY the deploy id, or ONLY the endpoint, yields
    // a different joined cache key (so neither can reuse the other's payload).
    const key = parts.join("\0");
    expect([parts[0], "other-deploy", parts[2]].join("\0")).not.toBe(key);
    expect(
      [parts[0], parts[1], "celo-mainnet=https://other/graphql"].join("\0"),
    ).not.toBe(key);
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

    expect(result?.pool.Pool[0]).toMatchObject(VIRTUAL_POOL);
    expect(result?.pool.Pool[0]?.oracleFreshnessCheckedAt).toBeGreaterThan(0);
    expect(result?.thresholds?.Pool[0]?.tokenDecimalsKnown).toBe(true);
    expect(result?.vpOracleFreshness?.Pool[0]?.medianLive).toBe(true);
    expect(
      result?.vpOracleFreshness?.Pool[0]?.vpOracleFreshnessCheckedAt,
    ).toBeGreaterThan(0);
    expect(result?.vpDeprecation?.BiPoolExchange[0]?.minimumReports).toBe("1");
    expect(result?.vpLifecycleDeprecation?.VirtualPoolLifecycle).toEqual([]);
    expect(result?.v2Exchange).toEqual(V2_EXCHANGE_RESPONSE);
    expect(
      result?.brokerExchange24h?.BrokerExchangeDailySnapshot[0],
    ).toMatchObject({
      volumeUsdWei: "42000000000000000000",
      swapCount: 3,
    });
    // Virtual pools skip POOL_BREAKER_CONFIG (mirrors the client query gate),
    // so no breaker fallback is prefetched and the request count stays 7.
    expect(result?.breakerConfig).toBeUndefined();
    expect(
      requestMock.mock.calls.some(
        ([request]) =>
          (request as { document: string }).document === POOL_BREAKER_CONFIG,
      ),
    ).toBe(false);
    expect(requestMock).toHaveBeenCalledTimes(7);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(HASURA_TIMEOUT_MS);
    const signals = requestMock.mock.calls.map(([request]) => {
      return (request as { signal: AbortSignal }).signal;
    });
    expect(new Set(signals).size).toBe(1);
  });

  it("prefetches POOL_BREAKER_CONFIG for FPMM pools with a rateFeedID", async () => {
    requestMock.mockImplementation(({ document }: { document: string }) => {
      if (document === POOL_DETAIL_WITH_HEALTH) {
        return { Pool: [FPMM_POOL] };
      }
      if (document === POOL_THRESHOLDS_KNOWN_EXT) {
        return {
          Pool: [
            {
              id: FPMM_POOL.id,
              rebalanceThresholdsKnown: true,
              tokenDecimalsKnown: true,
            },
          ],
        };
      }
      if (document === POOL_VP_ORACLE_FRESHNESS_EXT) {
        return { Pool: [{ id: FPMM_POOL.id, medianLive: true }] };
      }
      if (document === POOL_VP_DEPRECATION_EXT) {
        return { BiPoolExchange: [] };
      }
      if (document === POOL_VP_LIFECYCLE_DEPRECATION_EXT) {
        return { VirtualPoolLifecycle: [] };
      }
      if (document === POOL_BREAKER_CONFIG) {
        return BREAKER_CONFIG_RESPONSE;
      }
      throw new Error("unexpected query");
    });

    const result = await fetchPoolDetailForSSR(42220, FPMM_POOL.id);

    // FPMM pools are not virtual, so the header extension fetch makes no
    // POOL_V2_EXCHANGE / broker calls; the breaker prefetch is the only extra.
    expect(result?.breakerConfig).toEqual(BREAKER_CONFIG_RESPONSE);
    const breakerCall = requestMock.mock.calls.find(
      ([request]) =>
        (request as { document: string }).document === POOL_BREAKER_CONFIG,
    );
    expect(breakerCall?.[0]).toMatchObject({
      variables: { chainId: 42220, rateFeedID: FX_FEED },
    });
    expect(result?.v2Exchange).toBeUndefined();
    expect(result?.brokerExchange24h).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(6);
  });

  it("age-gates the cached breaker fallback: over-age strips breakerConfig (SWR loads fresh) while keeping the pool row (Codex finding, issue #1257)", async () => {
    requestMock.mockImplementation(({ document }: { document: string }) => {
      if (document === POOL_DETAIL_WITH_HEALTH) return { Pool: [FPMM_POOL] };
      if (document === POOL_THRESHOLDS_KNOWN_EXT) {
        return {
          Pool: [
            {
              id: FPMM_POOL.id,
              rebalanceThresholdsKnown: true,
              tokenDecimalsKnown: true,
            },
          ],
        };
      }
      if (document === POOL_VP_ORACLE_FRESHNESS_EXT) {
        return { Pool: [{ id: FPMM_POOL.id, medianLive: true }] };
      }
      if (document === POOL_VP_DEPRECATION_EXT) return { BiPoolExchange: [] };
      if (document === POOL_VP_LIFECYCLE_DEPRECATION_EXT) {
        return { VirtualPoolLifecycle: [] };
      }
      if (document === POOL_BREAKER_CONFIG) return BREAKER_CONFIG_RESPONSE;
      throw new Error("unexpected query");
    });

    vi.useFakeTimers();
    try {
      // `result.fetchedAt` is stamped with Date.now() at fetch — pin it.
      const fetchedAt = new Date("2026-01-01T00:00:00Z").getTime();
      vi.setSystemTime(fetchedAt);

      // Fresh (well within the 5-min max age): breakerConfig rides as fallback.
      const fresh = await fetchPoolDetailForSSR(
        42220,
        FPMM_POOL.id,
        fetchedAt + 1_000,
      );
      expect(fresh?.breakerConfig).toEqual(BREAKER_CONFIG_RESPONSE);

      // Over the 5-min max age (300_000ms): breakerConfig is stripped so SWR
      // loads the feed fresh instead of painting stale operator-safety state,
      // but the pool row + thresholds stay (header/health CLS fix unaffected).
      const stale = await fetchPoolDetailForSSR(
        42220,
        FPMM_POOL.id,
        fetchedAt + 300_001,
      );
      expect(stale?.breakerConfig).toBeUndefined();
      expect(stale?.pool.Pool[0]).toMatchObject(FPMM_POOL);
      expect(stale?.thresholds?.Pool[0]?.tokenDecimalsKnown).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades to an undefined breakerConfig when the breaker query fails, keeping siblings", async () => {
    requestMock.mockImplementation(({ document }: { document: string }) => {
      if (document === POOL_DETAIL_WITH_HEALTH) {
        return { Pool: [FPMM_POOL] };
      }
      if (document === POOL_THRESHOLDS_KNOWN_EXT) {
        return {
          Pool: [
            {
              id: FPMM_POOL.id,
              rebalanceThresholdsKnown: true,
              tokenDecimalsKnown: true,
            },
          ],
        };
      }
      if (document === POOL_VP_ORACLE_FRESHNESS_EXT) {
        return { Pool: [{ id: FPMM_POOL.id, medianLive: true }] };
      }
      if (document === POOL_VP_DEPRECATION_EXT) {
        return { BiPoolExchange: [] };
      }
      if (document === POOL_VP_LIFECYCLE_DEPRECATION_EXT) {
        return { VirtualPoolLifecycle: [] };
      }
      if (document === POOL_BREAKER_CONFIG) {
        throw new Error("field BreakerConfig not found");
      }
      throw new Error("unexpected query");
    });

    const result = await fetchPoolDetailForSSR(42220, FPMM_POOL.id);

    // The breaker query failing must not lose the base row or sibling
    // extensions — the client hook then loads breaker config normally and
    // its own reserved-height skeleton takes over.
    expect(result?.pool.Pool[0]).toMatchObject(FPMM_POOL);
    expect(result?.breakerConfig).toBeUndefined();
    expect(result?.thresholds?.Pool[0]?.tokenDecimalsKnown).toBe(true);
    expect(result?.vpOracleFreshness?.Pool[0]?.medianLive).toBe(true);
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

    expect(result?.pool.Pool[0]).toMatchObject(VIRTUAL_POOL);
    expect(result?.pool.Pool[0]?.oracleFreshnessCheckedAt).toBeGreaterThan(0);
    expect(result?.thresholds).toBeUndefined();
    expect(result?.vpOracleFreshness?.Pool[0]?.medianLive).toBe(true);
    expect(
      result?.vpOracleFreshness?.Pool[0]?.vpOracleFreshnessCheckedAt,
    ).toBeGreaterThan(0);
    expect(result?.v2Exchange).toEqual(V2_EXCHANGE_RESPONSE);
    expect(result?.brokerExchange24h?.BrokerExchangeDailySnapshot).toEqual([]);
  });

  it("drops the entire fallback when the primary pool payload is malformed before row access or freshness decoration", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    requestMock.mockResolvedValue({
      Pool: [{ ...VIRTUAL_POOL, chainId: "42220" }],
    });

    try {
      await expect(
        fetchPoolDetailForSSR(42220, VIRTUAL_POOL.id),
      ).resolves.toBeUndefined();
      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    [POOL_THRESHOLDS_KNOWN_EXT, "thresholds"],
    [POOL_VP_ORACLE_FRESHNESS_EXT, "vpOracleFreshness"],
    [POOL_VP_DEPRECATION_EXT, "vpDeprecation"],
    [POOL_VP_LIFECYCLE_DEPRECATION_EXT, "vpLifecycleDeprecation"],
  ] as const)(
    "drops only malformed optional response %s while retaining unrelated fallbacks",
    async (malformedDocument, droppedKey) => {
      const responses = validVirtualResponses();
      responses[malformedDocument] = { unexpected: "wrong-shape" };
      requestMock.mockImplementation(respondByDocument(responses));

      const result = await fetchPoolDetailForSSR(42220, VIRTUAL_POOL.id);

      expect(result?.pool.Pool[0]).toMatchObject(VIRTUAL_POOL);
      expect(result?.[droppedKey]).toBeUndefined();
      const independentKeys = [
        "thresholds",
        "vpOracleFreshness",
        "vpDeprecation",
        "vpLifecycleDeprecation",
      ] as const;
      for (const key of independentKeys) {
        if (key !== droppedKey) expect(result?.[key]).toBeDefined();
      }
      expect(result?.v2Exchange).toEqual(V2_EXCHANGE_RESPONSE);
      expect(result?.brokerExchange24h).toEqual(BROKER_24H_RESPONSE);
      if (droppedKey === "vpOracleFreshness") {
        expect(result?.vpOracleFreshness).toBeUndefined();
      } else {
        expect(
          result?.vpOracleFreshness?.Pool[0]?.vpOracleFreshnessCheckedAt,
        ).toBeGreaterThan(0);
      }
    },
  );

  it("drops a malformed v2 exchange and its unaddressable dependent volume request without losing independent pool extensions", async () => {
    const responses = validVirtualResponses();
    responses[POOL_V2_EXCHANGE] = { BiPoolExchange: [{ id: 123 }] };
    requestMock.mockImplementation(respondByDocument(responses));

    const result = await fetchPoolDetailForSSR(42220, VIRTUAL_POOL.id);

    expect(result?.pool.Pool[0]).toMatchObject(VIRTUAL_POOL);
    expect(result?.thresholds).toEqual(THRESHOLDS_RESPONSE);
    expect(result?.vpOracleFreshness?.Pool[0]?.medianLive).toBe(true);
    expect(result?.vpDeprecation).toEqual(VP_DEPRECATION_RESPONSE);
    expect(result?.vpLifecycleDeprecation).toEqual(VP_LIFECYCLE_RESPONSE);
    expect(result?.v2Exchange).toBeUndefined();
    expect(result?.brokerExchange24h).toBeUndefined();
    expect(
      requestMock.mock.calls.some(
        ([request]) =>
          (request as { document: string }).document ===
          BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H,
      ),
    ).toBe(false);
  });

  it("drops only a malformed broker 24h payload while retaining the valid v2 exchange and pool extensions", async () => {
    const responses = validVirtualResponses();
    responses[BROKER_EXCHANGE_DAILY_SNAPSHOTS_24H] = {
      BrokerExchangeDailySnapshot: [{ swapCount: "3" }],
    };
    requestMock.mockImplementation(respondByDocument(responses));

    const result = await fetchPoolDetailForSSR(42220, VIRTUAL_POOL.id);

    expect(result?.pool.Pool[0]).toMatchObject(VIRTUAL_POOL);
    expect(result?.thresholds).toEqual(THRESHOLDS_RESPONSE);
    expect(result?.v2Exchange).toEqual(V2_EXCHANGE_RESPONSE);
    expect(result?.brokerExchange24h).toBeUndefined();
  });

  it("drops only a malformed breaker-config payload for an FPMM pool", async () => {
    const responses: Record<string, unknown> = {
      [POOL_DETAIL_WITH_HEALTH]: { Pool: [FPMM_POOL] },
      [POOL_THRESHOLDS_KNOWN_EXT]: {
        Pool: [{ id: FPMM_POOL.id, tokenDecimalsKnown: true }],
      },
      [POOL_VP_ORACLE_FRESHNESS_EXT]: {
        Pool: [{ id: FPMM_POOL.id, medianLive: true }],
      },
      [POOL_VP_DEPRECATION_EXT]: { BiPoolExchange: [] },
      [POOL_VP_LIFECYCLE_DEPRECATION_EXT]: { VirtualPoolLifecycle: [] },
      [POOL_BREAKER_CONFIG]: {
        BreakerConfig: [{ status: "NOT_A_STATUS" }],
        BreakerTripEvent: [],
      },
    };
    requestMock.mockImplementation(respondByDocument(responses));

    const result = await fetchPoolDetailForSSR(42220, FPMM_POOL.id);

    expect(result?.pool.Pool[0]).toMatchObject(FPMM_POOL);
    expect(result?.thresholds?.Pool[0]?.tokenDecimalsKnown).toBe(true);
    expect(result?.vpOracleFreshness?.Pool[0]?.medianLive).toBe(true);
    expect(result?.breakerConfig).toBeUndefined();
  });
});
