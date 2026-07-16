import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleGraphQL,
  shouldDelayPoolBreakerResponse,
} from "../tests/browser/fixtures/hasura-fixture-server.mjs";

const DAY_SECONDS = 86_400;
const QUERY =
  "query HomepageOgDailySnapshots { PoolDailySnapshot { timestamp } }";
const POOL_ID = "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
const FIXED_NOW_MS = Date.UTC(2026, 5, 16, 12, 0, 0);
const LIGHTHOUSE_SCENARIO = "lighthouse-pool";
const LIGHTHOUSE_RATE_FEED_ID = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const POOL_DETAIL_QUERY =
  "query PoolDetailWithHealth { Pool { referenceRateFeedID } }";
const BREAKER_QUERY =
  "query PoolBreakerConfig { BreakerConfig { medianRatesEMA } }";
const RATE_FEED_QUERY =
  "query PoolRateFeedExt { RateFeed { feedAddress pair reporterTypes } }";

function dailyRows(variables) {
  return handleGraphQL({ query: QUERY, variables }).PoolDailySnapshot;
}

describe("hasura fixture daily snapshot filters", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("honors HomepageOgDailySnapshots since variables", () => {
    const todayStart =
      Math.floor(FIXED_NOW_MS / 1000 / DAY_SECONDS) * DAY_SECONDS;

    const rows = dailyRows({
      poolIds: [],
      since: todayStart - 1,
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => Number(row.timestamp) === todayStart)).toBe(
      true,
    );
  });

  it("prefers afterTimestamp when both daily snapshot variables are present", () => {
    const todayStart =
      Math.floor(FIXED_NOW_MS / 1000 / DAY_SECONDS) * DAY_SECONDS;

    const rows = dailyRows({
      poolIds: [],
      afterTimestamp: 0,
      since: todayStart - 1,
    });

    // Five rows per fixture pool (today, 1d, 2d, plus deliberate 365d and
    // 366d full-history sentinels used by the bounded-SSR browser flow).
    expect(rows).toHaveLength(10);
  });

  it.each(["PoolDailySnapshotsChart", "PoolOgDailySnapshots"])(
    "keeps the old all-history sentinels out of %s",
    (operation) => {
      const todayStart =
        Math.floor(FIXED_NOW_MS / 1000 / DAY_SECONDS) * DAY_SECONDS;
      const rows = handleGraphQL({
        query: `query ${operation} { PoolDailySnapshot { timestamp } }`,
        variables: { poolId: POOL_ID },
      }).PoolDailySnapshot;

      expect(rows).toHaveLength(3);
      expect(rows.map((row) => Number(row.timestamp))).toEqual([
        todayStart,
        todayStart - DAY_SECONDS,
        todayStart - 2 * DAY_SECONDS,
      ]);
    },
  );
});

describe("hasura fixture scenarios", () => {
  it("keeps the default canonical pool fixture breaker-free", () => {
    const response = handleGraphQL({
      query: POOL_DETAIL_QUERY,
      variables: { id: POOL_ID, chainId: 42220 },
    });

    expect(response.Pool).toHaveLength(1);
    expect(response.Pool[0]?.referenceRateFeedID).toBe("");
  });

  it("gives the lighthouse pool a stable feed and deterministic healthy MedianDelta config", () => {
    const poolResponse = handleGraphQL(
      {
        query: POOL_DETAIL_QUERY,
        variables: { id: POOL_ID, chainId: 42220 },
      },
      LIGHTHOUSE_SCENARIO,
    );
    const breakerResponse = handleGraphQL(
      {
        query: BREAKER_QUERY,
        variables: {
          chainId: 42220,
          rateFeedID: LIGHTHOUSE_RATE_FEED_ID,
        },
      },
      LIGHTHOUSE_SCENARIO,
    );
    const rateFeedResponse = handleGraphQL(
      {
        query: RATE_FEED_QUERY,
        variables: {
          chainId: 42220,
          feedAddress: LIGHTHOUSE_RATE_FEED_ID,
        },
      },
      LIGHTHOUSE_SCENARIO,
    );

    expect(poolResponse.Pool[0]?.referenceRateFeedID).toBe(
      LIGHTHOUSE_RATE_FEED_ID,
    );
    expect(breakerResponse).toMatchObject({
      BreakerConfig: [
        {
          status: "OK",
          tradingMode: 0,
          medianRatesEMA: "1171560280196965000000000",
          lastMedianRate: "1175000000000000000000000",
          breaker: {
            kind: "MEDIAN_DELTA",
            defaultCooldownTime: "900",
            defaultRateChangeThreshold: "40000000000000000000000",
          },
        },
      ],
      BreakerTripEvent: [],
    });
    expect(rateFeedResponse).toEqual({
      RateFeed: [
        {
          id: `42220-${LIGHTHOUSE_RATE_FEED_ID}`,
          chainId: 42220,
          feedAddress: LIGHTHOUSE_RATE_FEED_ID,
          pair: "EUR/USD",
          reporterTypes: ["CHAINLINK"],
        },
      ],
    });
  });

  it("returns empty lighthouse extension rows for a mismatched pool feed", () => {
    const response = handleGraphQL(
      {
        query: RATE_FEED_QUERY,
        variables: {
          chainId: 42220,
          feedAddress: "0x0000000000000000000000000000000000000000",
        },
      },
      LIGHTHOUSE_SCENARIO,
    );

    expect(response).toEqual({ RateFeed: [] });
  });

  it("accepts the scenario on the request object for direct callers", () => {
    const response = handleGraphQL({
      query: POOL_DETAIL_QUERY,
      variables: { id: POOL_ID, chainId: 42220 },
      scenario: LIGHTHOUSE_SCENARIO,
    });

    expect(response.Pool[0]?.referenceRateFeedID).toBe(LIGHTHOUSE_RATE_FEED_ID);
  });

  it("rejects unknown scenarios instead of silently serving default data", () => {
    expect(() =>
      handleGraphQL(
        {
          query: POOL_DETAIL_QUERY,
          variables: { id: POOL_ID, chainId: 42220 },
        },
        "typo",
      ),
    ).toThrow("Unknown Hasura fixture scenario: typo");
  });

  it("delays only browser-origin PoolBreakerConfig requests", () => {
    expect(
      shouldDelayPoolBreakerResponse(
        { query: BREAKER_QUERY },
        { origin: "http://127.0.0.1:3210" },
        2200,
      ),
    ).toBe(true);
    expect(
      shouldDelayPoolBreakerResponse({ query: BREAKER_QUERY }, {}, 2200),
    ).toBe(false);
    expect(
      shouldDelayPoolBreakerResponse(
        { query: POOL_DETAIL_QUERY },
        { origin: "http://127.0.0.1:3210" },
        2200,
      ),
    ).toBe(false);
    expect(
      shouldDelayPoolBreakerResponse(
        { query: BREAKER_QUERY },
        { origin: "http://127.0.0.1:3210" },
        0,
      ),
    ).toBe(false);
  });
});
