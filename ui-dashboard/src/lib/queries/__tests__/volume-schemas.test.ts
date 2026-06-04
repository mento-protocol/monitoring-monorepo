/**
 * Focused shape tests for volume Zod schemas.
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
  BrokerVolumePartialOverlapTradersSchema,
  BrokerVolumeTodayTradersSchema,
  BrokerVolumeWindowFirstDayLatestSchema,
  BrokerVolumeWindowLatestSchema,
  BrokerVolumeYesterdayTradersSchema,
  BrokerTraderDailyTopSchema,
  VolumePartialOverlapTradersSchema,
  VolumeTodayTradersSchema,
  VolumeWindowFirstDayLatestSchema,
  VolumeWindowLatestSchema,
  VolumeWindowTradersLatestSchema,
  VolumeYesterdayTradersSchema,
  PoolDailyVolumeSchema,
  PoolsForVolumeSchema,
  SwapEventOutliersSchema,
  TraderDailyTopSchema,
  TraderDailyWindowTopSchema,
  TraderPoolDailyForTraderSchema,
  TraderPoolDailyTopSchema,
} from "../volume-schemas";

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
  isProtocolActor: false,
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

  it("fails when isProtocolActor is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { isProtocolActor: _omit, ...row } = minimalTraderDailyRow;
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
// Deep-tested schema 2: VolumeWindowLatestSchema
// ---------------------------------------------------------------------------

const minimalWindowRow = {
  id: "42220-7d-100",
  chainId: 42220,
  windowKey: "7d",
  snapshotDay: "100",
  windowStartDay: "93",
  totalVolumeUsdWei: "9000000000000000000000",
  totalVolumeUsdWeiIncludingProtocolActors: "9500000000000000000000",
  totalSwapCount: 500,
  totalSwapCountIncludingProtocolActors: 520,
  uniqueTraders: 42,
  uniqueTradersIncludingProtocolActors: 45,
};

describe("VolumeWindowLatestSchema", () => {
  it("passes with a full valid row", () => {
    const result = VolumeWindowLatestSchema.safeParse({
      volumeWindowSnapshots: [minimalWindowRow],
    });
    expect(result.success).toBe(true);
  });

  it("passes with empty results array", () => {
    const result = VolumeWindowLatestSchema.safeParse({
      volumeWindowSnapshots: [],
    });
    expect(result.success).toBe(true);
  });

  it("fails when the root key is wrong (Hasura drift)", () => {
    // Simulate Hasura returning a renamed entity
    const result = VolumeWindowLatestSchema.safeParse({
      WrongEntityName: [minimalWindowRow],
    });
    expect(result.success).toBe(false);
  });

  it("fails when uniqueTraders is a string instead of number", () => {
    const result = VolumeWindowLatestSchema.safeParse({
      volumeWindowSnapshots: [{ ...minimalWindowRow, uniqueTraders: "42" }],
    });
    expect(result.success).toBe(false);
  });

  it("produces a GraphQLSchemaError on parse failure", () => {
    const result = VolumeWindowLatestSchema.safeParse({
      volumeWindowSnapshots: [{ chainId: "not-a-number" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = new GraphQLSchemaError(
        result.error.issues,
        "VolumeWindowLatest",
      );
      expect(err).toBeInstanceOf(GraphQLSchemaError);
      expect(err.message).toContain("chainId");
    }
  });

  // Broker sibling shares the same inner row shape
  it("BrokerVolumeWindowLatestSchema passes with same row shape", () => {
    const result = BrokerVolumeWindowLatestSchema.safeParse({
      brokerVolumeWindowSnapshots: [minimalWindowRow],
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

describe("PoolsForVolumeSchema smoke test", () => {
  it("passes with nullable token0/token1", () => {
    const result = PoolsForVolumeSchema.safeParse({
      Pool: [{ id: "0xpool", chainId: 42220, token0: null, token1: null }],
    });
    expect(result.success).toBe(true);
  });
  it("fails when chainId is missing", () => {
    expect(
      PoolsForVolumeSchema.safeParse({ Pool: [{ id: "0xpool" }] }).success,
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
          swapCountIncludingProtocolActors: 12,
          volumeUsdWei: "1000",
          volumeUsdWeiIncludingProtocolActors: "1100",
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
          swapCountIncludingProtocolActors: 51,
          uniqueTraders: 10,
          uniqueTradersIncludingProtocolActors: 11,
          volumeUsdWei: "9999",
          volumeUsdWeiIncludingProtocolActors: "10001",
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
          isProtocolActor: false,
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
          isProtocolActor: false,
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

describe("VolumeWindowFirstDayLatestSchema smoke test", () => {
  it("passes and brokersibling passes", () => {
    const row = {
      chainId: 42220,
      snapshotDay: "100",
      firstDayVolumeUsdWei: "1000",
      firstDayVolumeUsdWeiIncludingProtocolActors: "1100",
      firstDaySwapCount: 10,
      firstDaySwapCountIncludingProtocolActors: 11,
      firstDayExclusiveUniqueTraders: 3,
      firstDayExclusiveUniqueTradersIncludingProtocolActors: 4,
    };
    expect(
      VolumeWindowFirstDayLatestSchema.safeParse({
        volumeWindowFirstDaySnapshots: [row],
      }).success,
    ).toBe(true);
    expect(
      BrokerVolumeWindowFirstDayLatestSchema.safeParse({
        brokerVolumeWindowFirstDaySnapshots: [row],
      }).success,
    ).toBe(true);
  });
});

describe("VolumeWindowTradersLatestSchema smoke test", () => {
  it("accepts a row with the v3 trader address array", () => {
    const row = {
      chainId: 42220,
      snapshotDay: "100",
      windowTraders: ["0xaaa", "0xbbb"],
    };
    expect(
      VolumeWindowTradersLatestSchema.safeParse({
        volumeWindowTraderSnapshots: [row],
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
      VolumeWindowTradersLatestSchema.safeParse({
        volumeWindowTraderSnapshots: [row],
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
      VolumeWindowTradersLatestSchema.safeParse({
        volumeWindowTraderSnapshots: [row],
      }).success,
    ).toBe(false);
  });
});

describe("VolumeTodayTradersSchema smoke test", () => {
  const partialRow = {
    chainId: 42220,
    trader: "0xtrader",
    volumeUsdWei: "1000",
    swapCount: 2,
    isProtocolActor: false,
  };
  it("passes for v3 today traders", () => {
    expect(
      VolumeTodayTradersSchema.safeParse({
        volumeTodayTraders: [partialRow],
      }).success,
    ).toBe(true);
  });
  it("passes for broker today traders", () => {
    expect(
      BrokerVolumeTodayTradersSchema.safeParse({
        brokerVolumeTodayTraders: [partialRow],
      }).success,
    ).toBe(true);
  });
  it("passes for yesterday traders", () => {
    expect(
      VolumeYesterdayTradersSchema.safeParse({
        volumeYesterdayTraders: [partialRow],
      }).success,
    ).toBe(true);
    expect(
      BrokerVolumeYesterdayTradersSchema.safeParse({
        brokerVolumeYesterdayTraders: [partialRow],
      }).success,
    ).toBe(true);
  });
});

describe("VolumePartialOverlapTradersSchema smoke test", () => {
  const overlapRow = {
    chainId: 42220,
    trader: "0xtrader",
    timestamp: "1700000000",
    isProtocolActor: false,
  };
  it("passes for v3", () => {
    expect(
      VolumePartialOverlapTradersSchema.safeParse({
        volumePartialOverlapTraders: [overlapRow],
      }).success,
    ).toBe(true);
  });
  it("passes for broker", () => {
    expect(
      BrokerVolumePartialOverlapTradersSchema.safeParse({
        brokerVolumePartialOverlapTraders: [overlapRow],
      }).success,
    ).toBe(true);
  });
  it("fails when isProtocolActor is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { isProtocolActor: _omit, ...rowNoSystem } = overlapRow;
    expect(
      VolumePartialOverlapTradersSchema.safeParse({
        volumePartialOverlapTraders: [rowNoSystem],
      }).success,
    ).toBe(false);
  });
});
