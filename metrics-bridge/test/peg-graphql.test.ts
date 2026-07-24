import { describe, expect, it, vi } from "vitest";

import {
  fetchPegStructuralContext,
  PEG_BREAKER_CONFIG_LIMIT,
  PEG_STRUCTURAL_PAGE_LIMIT,
  PEG_STRUCTURAL_QUERY,
  type PegStructuralQueryResponse,
  type PegStructuralRequest,
} from "../src/peg/graphql.js";

const POOL_ID = "137-0x0000000000000000000000000000000000000001";
const MONITORED_ASSET = "0x0000000000000000000000000000000000000002";
const RATE_FEED_ID = "0x0000000000000000000000000000000000000004";

const pool = {
  id: POOL_ID,
  chainId: 137,
  source: "fpmm_factory",
  token0: MONITORED_ASSET,
  token1: "0x0000000000000000000000000000000000000003",
  token0Decimals: 6,
  token1Decimals: 18,
  reserves0: "1000000",
  reserves1: "2000000000000000000",
  referenceRateFeedID: RATE_FEED_ID,
};

const breakerConfig = {
  id: "137-breaker-feed",
  enabled: true,
  rateChangeThreshold: "0",
  referenceValue: "1000000000000000000000000",
  lastMedianRate: "999000000000000000000000",
  lastUpdatedAt: "1784734420",
  status: "OK" as const,
  tradingMode: 0,
  lastStatusUpdatedAt: "1784734400",
  breaker: {
    id: "137-breaker",
    address: "0x0000000000000000000000000000000000000006",
    kind: "VALUE_DELTA" as const,
    defaultRateChangeThreshold: "50000000000000000000000",
    removed: false,
  },
};

const tradingLimit = {
  id: `${POOL_ID}-${MONITORED_ASSET}`,
  chainId: 137,
  poolId: POOL_ID,
  token: MONITORED_ASSET,
  limit0: "1000000000000000000",
  limit1: "10000000000000000000",
  decimals: 15,
  netflow0: "0",
  netflow1: "0",
  lastUpdated0: "1000",
  lastUpdated1: "1000",
  updatedAtBlock: "42",
  updatedAtTimestamp: "1000",
};

function swap(index: number) {
  return {
    id: `swap-${index.toString().padStart(4, "0")}`,
    caller: "0x0000000000000000000000000000000000000005",
    amount0In: "1",
    amount1In: "0",
    amount0Out: "0",
    amount1Out: "1",
    blockTimestamp: "1000",
  };
}

function response(
  overrides: Partial<PegStructuralQueryResponse> = {},
): PegStructuralQueryResponse {
  return {
    Pool: [pool],
    TradingLimit: [tradingLimit],
    BreakerConfig: [],
    SwapEvent: [],
    ...overrides,
  };
}

const structuralInput = (since: bigint) => ({
  poolId: POOL_ID,
  monitoredToken: MONITORED_ASSET,
  chainId: 137,
  rateFeedId: RATE_FEED_ID,
  since,
});

function requestReturning(data: PegStructuralQueryResponse) {
  return vi.fn<PegStructuralRequest>().mockResolvedValue(data);
}

describe("fetchPegStructuralContext", () => {
  it("sends the bounded pool, token, and time variables through the injected request", async () => {
    const request = requestReturning(response());

    await fetchPegStructuralContext(structuralInput(1234n), request);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      document: PEG_STRUCTURAL_QUERY,
      variables: {
        poolId: POOL_ID,
        monitoredToken: MONITORED_ASSET,
        chainId: 137,
        rateFeedId: RATE_FEED_ID,
        since: "1234",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("uses deterministic descending pagination without an aggregate query", () => {
    const compact = PEG_STRUCTURAL_QUERY.replace(/\s+/g, " ");
    expect(compact).toContain("$since: numeric!");
    expect(compact).toContain(
      "order_by: [{ blockTimestamp: desc }, { id: desc }]",
    );
    expect(compact).toContain("limit: 1000");
    expect(compact).toContain("BreakerConfig(");
    expect(compact).toContain("order_by: { id: asc }");
    expect(compact).toContain(`limit: ${PEG_BREAKER_CONFIG_LIMIT}`);
    for (const field of [
      "rateChangeThreshold",
      "referenceValue",
      "lastMedianRate",
      "lastUpdatedAt",
      "lastStatusUpdatedAt",
      "defaultRateChangeThreshold",
      "removed",
    ]) {
      expect(compact).toContain(field);
    }
    expect(compact).not.toContain("_aggregate");
  });

  it("returns bounded breaker rows with the structural context", async () => {
    const result = await fetchPegStructuralContext(
      structuralInput(0n),
      requestReturning(response({ BreakerConfig: [breakerConfig] })),
    );

    expect(result).toMatchObject({
      status: "ok",
      breakerConfigs: [breakerConfig],
    });
  });

  it("does not mark a 999-row page saturated", async () => {
    const request = requestReturning(
      response({
        SwapEvent: Array.from({ length: 999 }, (_, index) => swap(index)),
      }),
    );

    const result = await fetchPegStructuralContext(
      structuralInput(0n),
      request,
    );

    expect(result.pageSaturated).toBe(false);
  });

  it("conservatively marks a full 1000-row page saturated", async () => {
    const request = requestReturning(
      response({
        SwapEvent: Array.from(
          { length: PEG_STRUCTURAL_PAGE_LIMIT },
          (_, index) => swap(index),
        ),
      }),
    );

    const result = await fetchPegStructuralContext(
      structuralInput(0n),
      request,
    );

    expect(result.pageSaturated).toBe(true);
  });

  it("reports indexed pool resolution loss separately", async () => {
    const request = requestReturning(response({ Pool: [] }));

    const result = await fetchPegStructuralContext(
      structuralInput(0n),
      request,
    );

    expect(result).toMatchObject({
      status: "pool_missing",
      poolId: POOL_ID,
      pageSaturated: false,
    });
  });

  it("reports a missing monitored-token TradingLimit separately", async () => {
    const request = requestReturning(response({ TradingLimit: [] }));

    const result = await fetchPegStructuralContext(
      structuralInput(0n),
      request,
    );

    expect(result).toMatchObject({
      status: "trading_limit_missing",
      pool,
      monitoredToken: MONITORED_ASSET,
      pageSaturated: false,
    });
  });
});
