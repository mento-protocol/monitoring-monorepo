/**
 * Focused shape tests for leaderboard Zod schemas.
 *
 * Three schemas are tested end-to-end with good fixtures + bad fixtures that
 * throw GraphQLSchemaError; the remaining schemas are smoke-tested via parse
 * round-trips. This follows the pattern in lib/__tests__/graphql-schema-error.test.ts.
 */

import { describe, expect, it } from "vitest";
import { GraphQLSchemaError } from "@/lib/graphql-schema-error";
import {
  AggregatorDailyTopSchema,
  BrokerAggregatorDailyTopSchema,
  BrokerLeaderboardPartialOverlapTradersSchema,
  BrokerLeaderboardTodayTradersSchema,
  BrokerLeaderboardWindowFirstDayLatestSchema,
  BrokerLeaderboardWindowLatestSchema,
  BrokerLeaderboardYesterdayTradersSchema,
  BrokerTraderDailyTopSchema,
  LeaderboardPartialOverlapTradersSchema,
  LeaderboardTodayTradersSchema,
  LeaderboardWindowFirstDayLatestSchema,
  LeaderboardWindowLatestSchema,
  LeaderboardWindowTradersLatestSchema,
  LeaderboardYesterdayTradersSchema,
  PoolDailyVolumeSchema,
  PoolsForLeaderboardSchema,
  SwapEventOutliersSchema,
  TraderDailyTopSchema,
  TraderDailyWindowTopSchema,
  TraderPoolDailyForTraderSchema,
  TraderPoolDailyTopSchema,
} from "../leaderboard-schemas";

// ---------------------------------------------------------------------------
// Deep-tested schema 1: TraderDailyTopSchema
// ---------------------------------------------------------------------------

const minimalTraderDailyRow = {
  id: "42220-0xabc-1700000000",
  chainId: 42220,
  trader: "0xabc",
  timestamp: "1700000000",
  swapCount: 5,
  uniquePools: 2,
  volumeUsdWei: "1000000000000000000000",
  feesPaidUsdWei: "500000000000000000",
  isSystemAddress: false,
  lastSeenTimestamp: "1700000000",
};

describe("TraderDailyTopSchema", () => {
  it("passes with minimal valid row", () => {
    const result = TraderDailyTopSchema.safeParse({
      TraderDailySnapshot: [minimalTraderDailyRow],
    });
    expect(result.success).toBe(true);
  });

  it("passes with an empty snapshot array", () => {
    const result = TraderDailyTopSchema.safeParse({ TraderDailySnapshot: [] });
    expect(result.success).toBe(true);
  });

  it("fails when TraderDailySnapshot is missing", () => {
    const result = TraderDailyTopSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("fails when chainId is a string instead of number", () => {
    const result = TraderDailyTopSchema.safeParse({
      TraderDailySnapshot: [{ ...minimalTraderDailyRow, chainId: "42220" }],
    });
    expect(result.success).toBe(false);
  });

  it("fails when isSystemAddress is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { isSystemAddress: _omit, ...row } = minimalTraderDailyRow;
    const result = TraderDailyTopSchema.safeParse({
      TraderDailySnapshot: [row],
    });
    expect(result.success).toBe(false);
  });

  it("produces a GraphQLSchemaError from parse failure", () => {
    const result = TraderDailyTopSchema.safeParse({
      TraderDailySnapshot: [{ id: 999 }], // id must be string
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new GraphQLSchemaError(result.error.issues, "TraderDailyTop");
      expect(err).toBeInstanceOf(GraphQLSchemaError);
      expect(err.message).toContain("[TraderDailyTop]");
      expect(err.issues.length).toBeGreaterThan(0);
    }
  });

  // TraderDailyWindowTopSchema shares the same row shape
  it("TraderDailyWindowTopSchema round-trips cleanly", () => {
    const result = TraderDailyWindowTopSchema.safeParse({
      TraderDailySnapshot: [minimalTraderDailyRow],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deep-tested schema 2: LeaderboardWindowLatestSchema
// ---------------------------------------------------------------------------

const minimalWindowRow = {
  id: "42220-7d-100",
  chainId: 42220,
  windowKey: "7d",
  snapshotDay: "100",
  windowStartDay: "93",
  totalVolumeUsdWei: "9000000000000000000000",
  totalVolumeUsdWeiIncludingSystem: "9500000000000000000000",
  totalSwapCount: 500,
  totalSwapCountIncludingSystem: 520,
  uniqueTraders: 42,
  uniqueTradersIncludingSystem: 45,
};

describe("LeaderboardWindowLatestSchema", () => {
  it("passes with a full valid row", () => {
    const result = LeaderboardWindowLatestSchema.safeParse({
      LeaderboardWindowSnapshot: [minimalWindowRow],
    });
    expect(result.success).toBe(true);
  });

  it("passes with empty results array", () => {
    const result = LeaderboardWindowLatestSchema.safeParse({
      LeaderboardWindowSnapshot: [],
    });
    expect(result.success).toBe(true);
  });

  it("fails when the root key is wrong (Hasura drift)", () => {
    // Simulate Hasura returning a renamed entity
    const result = LeaderboardWindowLatestSchema.safeParse({
      WrongEntityName: [minimalWindowRow],
    });
    expect(result.success).toBe(false);
  });

  it("fails when uniqueTraders is a string instead of number", () => {
    const result = LeaderboardWindowLatestSchema.safeParse({
      LeaderboardWindowSnapshot: [{ ...minimalWindowRow, uniqueTraders: "42" }],
    });
    expect(result.success).toBe(false);
  });

  it("produces a GraphQLSchemaError on parse failure", () => {
    const result = LeaderboardWindowLatestSchema.safeParse({
      LeaderboardWindowSnapshot: [{ chainId: "not-a-number" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new GraphQLSchemaError(
        result.error.issues,
        "LeaderboardWindowLatest",
      );
      expect(err).toBeInstanceOf(GraphQLSchemaError);
      expect(err.message).toContain("chainId");
    }
  });

  // Broker sibling shares the same inner row shape
  it("BrokerLeaderboardWindowLatestSchema passes with same row shape", () => {
    const result = BrokerLeaderboardWindowLatestSchema.safeParse({
      BrokerLeaderboardWindowSnapshot: [minimalWindowRow],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deep-tested schema 3: SwapEventOutliersSchema
// ---------------------------------------------------------------------------

const minimalSwapOutlierRow = {
  id: "42220-0xtxhash-0",
  chainId: 42220,
  poolId: "0xpool",
  caller: "0xcaller",
  txTo: "0xto",
  recipient: "0xrecipient",
  volumeUsdWei: "5000000000000000000000",
  txHash: "0xtxhash",
  blockTimestamp: "1700000000",
};

describe("SwapEventOutliersSchema", () => {
  it("passes with a valid row", () => {
    const result = SwapEventOutliersSchema.safeParse({
      SwapEvent: [minimalSwapOutlierRow],
    });
    expect(result.success).toBe(true);
  });

  it("passes with empty SwapEvent array", () => {
    const result = SwapEventOutliersSchema.safeParse({ SwapEvent: [] });
    expect(result.success).toBe(true);
  });

  it("fails when chainId is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { chainId: _omit, ...row } = minimalSwapOutlierRow;
    const result = SwapEventOutliersSchema.safeParse({ SwapEvent: [row] });
    expect(result.success).toBe(false);
  });

  it("fails when volumeUsdWei is a number (should be string from Hasura)", () => {
    const result = SwapEventOutliersSchema.safeParse({
      SwapEvent: [{ ...minimalSwapOutlierRow, volumeUsdWei: 5000 }],
    });
    expect(result.success).toBe(false);
  });

  it("produces a GraphQLSchemaError with the query name hint", () => {
    const result = SwapEventOutliersSchema.safeParse({
      SwapEvent: [{ chainId: "not-a-number" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new GraphQLSchemaError(
        result.error.issues,
        "SwapEventOutliers",
      );
      expect(err).toBeInstanceOf(GraphQLSchemaError);
      expect(err.message).toContain("[SwapEventOutliers]");
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke tests for remaining schemas (round-trip valid data + fail on empty obj)
// ---------------------------------------------------------------------------

describe("TraderPoolDailyForTraderSchema smoke test", () => {
  it("passes with a valid row", () => {
    const result = TraderPoolDailyForTraderSchema.safeParse({
      TraderPoolDailySnapshot: [
        {
          id: "42220-0xpool-0xtrader-100",
          chainId: 42220,
          trader: "0xtrader",
          poolId: "0xpool",
          timestamp: "1700000000",
          swapCount: 3,
          volumeUsdWei: "100",
          inflowToken0UsdWei: "50",
          outflowToken0UsdWei: "0",
          inflowToken1UsdWei: "0",
          outflowToken1UsdWei: "50",
          feesPaidUsdWei: "1",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
  it("fails when root key is missing", () => {
    expect(TraderPoolDailyForTraderSchema.safeParse({}).success).toBe(false);
  });
});

describe("TraderPoolDailyTopSchema smoke test", () => {
  it("passes with empty array", () => {
    expect(
      TraderPoolDailyTopSchema.safeParse({ TraderPoolDailySnapshot: [] })
        .success,
    ).toBe(true);
  });
  it("fails when root key is missing", () => {
    expect(TraderPoolDailyTopSchema.safeParse({}).success).toBe(false);
  });
});

describe("PoolsForLeaderboardSchema smoke test", () => {
  it("passes with nullable token0/token1", () => {
    const result = PoolsForLeaderboardSchema.safeParse({
      Pool: [{ id: "0xpool", chainId: 42220, token0: null, token1: null }],
    });
    expect(result.success).toBe(true);
  });
  it("fails when chainId is missing", () => {
    expect(
      PoolsForLeaderboardSchema.safeParse({ Pool: [{ id: "0xpool" }] }).success,
    ).toBe(false);
  });
});

describe("PoolDailyVolumeSchema smoke test", () => {
  it("passes with a valid row", () => {
    const result = PoolDailyVolumeSchema.safeParse({
      PoolDailyVolumeSnapshot: [
        {
          id: "42220-0xpool-100",
          chainId: 42220,
          poolId: "0xpool",
          timestamp: "1700000000",
          swapCount: 10,
          swapCountIncludingSystem: 12,
          volumeUsdWei: "1000",
          volumeUsdWeiIncludingSystem: "1100",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("AggregatorDailyTopSchema smoke test", () => {
  it("passes with a valid row", () => {
    const result = AggregatorDailyTopSchema.safeParse({
      AggregatorDailySnapshot: [
        {
          id: "42220-uniswap-100",
          chainId: 42220,
          aggregator: "uniswap",
          lastSeenAggregatorAddress: "0xrouter",
          timestamp: "1700000000",
          swapCount: 50,
          swapCountIncludingSystem: 51,
          uniqueTraders: 10,
          uniqueTradersIncludingSystem: 11,
          volumeUsdWei: "9999",
          volumeUsdWeiIncludingSystem: "10001",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("BrokerTraderDailyTopSchema smoke test", () => {
  it("accepts the trader alias field (not caller)", () => {
    // The GQL query aliases `caller` → `trader`; Hasura returns the aliased name
    const result = BrokerTraderDailyTopSchema.safeParse({
      BrokerTraderDailySnapshot: [
        {
          id: "42220-0xtrader-100",
          chainId: 42220,
          trader: "0xtrader",
          timestamp: "1700000000",
          swapCount: 5,
          volumeUsdWei: "1000",
          isSystemAddress: false,
          lastSeenTimestamp: "1700000000",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
  it("rejects rows missing the trader alias (e.g. raw caller field returned)", () => {
    // If the GQL alias `caller → trader` is dropped, Hasura returns `caller`
    // instead. Zod strips unknown keys, so `caller` is ignored — but the
    // required `trader` field is absent, causing the parse to fail.
    const result = BrokerTraderDailyTopSchema.safeParse({
      BrokerTraderDailySnapshot: [
        {
          id: "42220-0xtrader-100",
          chainId: 42220,
          caller: "0xtrader", // raw field — trader alias missing
          timestamp: "1700000000",
          swapCount: 5,
          volumeUsdWei: "1000",
          isSystemAddress: false,
          lastSeenTimestamp: "1700000000",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("BrokerAggregatorDailyTopSchema smoke test", () => {
  it("passes with a valid row", () => {
    const result = BrokerAggregatorDailyTopSchema.safeParse({
      BrokerAggregatorDailySnapshot: [
        {
          id: "42220-unknown-100",
          chainId: 42220,
          aggregator: "unknown",
          lastSeenAggregatorAddress: "0xunknown",
          timestamp: "1700000000",
          swapCount: 3,
          uniqueTraders: 2,
          volumeUsdWei: "500",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("LeaderboardWindowFirstDayLatestSchema smoke test", () => {
  it("passes and brokersibling passes", () => {
    const row = {
      chainId: 42220,
      snapshotDay: "100",
      firstDayVolumeUsdWei: "1000",
      firstDayVolumeUsdWeiIncludingSystem: "1100",
      firstDaySwapCount: 10,
      firstDaySwapCountIncludingSystem: 11,
      firstDayExclusiveUniqueTraders: 3,
      firstDayExclusiveUniqueTradersIncludingSystem: 4,
    };
    expect(
      LeaderboardWindowFirstDayLatestSchema.safeParse({
        LeaderboardWindowSnapshot: [row],
      }).success,
    ).toBe(true);
    expect(
      BrokerLeaderboardWindowFirstDayLatestSchema.safeParse({
        BrokerLeaderboardWindowSnapshot: [row],
      }).success,
    ).toBe(true);
  });
});

describe("LeaderboardWindowTradersLatestSchema smoke test", () => {
  it("accepts a row with the v3 trader address array", () => {
    const row = {
      chainId: 42220,
      snapshotDay: "100",
      windowTraders: ["0xaaa", "0xbbb"],
    };
    expect(
      LeaderboardWindowTradersLatestSchema.safeParse({
        LeaderboardWindowSnapshot: [row],
      }).success,
    ).toBe(true);
  });

  it("accepts an empty array (no v3 swaps yet on this chain)", () => {
    const row = {
      chainId: 143,
      snapshotDay: "100",
      windowTraders: [],
    };
    expect(
      LeaderboardWindowTradersLatestSchema.safeParse({
        LeaderboardWindowSnapshot: [row],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-string entry in windowTraders", () => {
    const row = {
      chainId: 42220,
      snapshotDay: "100",
      windowTraders: ["0xaaa", 42],
    };
    expect(
      LeaderboardWindowTradersLatestSchema.safeParse({
        LeaderboardWindowSnapshot: [row],
      }).success,
    ).toBe(false);
  });
});

describe("LeaderboardTodayTradersSchema smoke test", () => {
  const partialRow = {
    chainId: 42220,
    trader: "0xtrader",
    volumeUsdWei: "1000",
    swapCount: 2,
    isSystemAddress: false,
  };
  it("passes for v3 today traders", () => {
    expect(
      LeaderboardTodayTradersSchema.safeParse({
        TraderDailySnapshot: [partialRow],
      }).success,
    ).toBe(true);
  });
  it("passes for broker today traders", () => {
    expect(
      BrokerLeaderboardTodayTradersSchema.safeParse({
        BrokerTraderDailySnapshot: [partialRow],
      }).success,
    ).toBe(true);
  });
  it("passes for yesterday traders", () => {
    expect(
      LeaderboardYesterdayTradersSchema.safeParse({
        TraderDailySnapshot: [partialRow],
      }).success,
    ).toBe(true);
    expect(
      BrokerLeaderboardYesterdayTradersSchema.safeParse({
        BrokerTraderDailySnapshot: [partialRow],
      }).success,
    ).toBe(true);
  });
});

describe("LeaderboardPartialOverlapTradersSchema smoke test", () => {
  const overlapRow = {
    chainId: 42220,
    trader: "0xtrader",
    timestamp: "1700000000",
    isSystemAddress: false,
  };
  it("passes for v3", () => {
    expect(
      LeaderboardPartialOverlapTradersSchema.safeParse({
        TraderDailySnapshot: [overlapRow],
      }).success,
    ).toBe(true);
  });
  it("passes for broker", () => {
    expect(
      BrokerLeaderboardPartialOverlapTradersSchema.safeParse({
        BrokerTraderDailySnapshot: [overlapRow],
      }).success,
    ).toBe(true);
  });
  it("fails when isSystemAddress is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { isSystemAddress: _omit, ...rowNoSystem } = overlapRow;
    expect(
      LeaderboardPartialOverlapTradersSchema.safeParse({
        TraderDailySnapshot: [rowNoSystem],
      }).success,
    ).toBe(false);
  });
});
