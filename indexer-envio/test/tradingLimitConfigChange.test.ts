import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
  type MockEventData,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import { createMockEventData } from "./helpers/eventFixtures.js";
import { setHttpRpcMock } from "../src/rpc/http-test-mocks.js";
import {
  _clearMockVpExchangeIds,
  _setMockVpExchangeId,
} from "../src/EventHandlers.ts";
import { makePool } from "./helpers/makePool.ts";
import { makePoolId } from "../src/helpers.ts";
import { tradingLimitId } from "../src/tradingLimits.ts";

// ---------------------------------------------------------------------------
// Issue #1053 scenario 6 — trading limits are keyed on (poolId, token), and a
// governance config change mid-window must NOT reset the accumulated
// netflow for a still-enabled window (`resetTradingLimitState` — see
// src/tradingLimits.ts). This exercises the real `FPMM.TradingLimitConfigured`
// handler through the harness, driven off a prior `FPMM.Swap`-derived
// TradingLimit row (the RPC-authoritative netflow source), and proves the
// OTHER token's key is untouched by a config change scoped to one token.
// ---------------------------------------------------------------------------

type MockDb = MockDbWith<{
  Pool: WritableEntity;
  TradingLimit: EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, FPMM } = TestHelpers;

const CHAIN_ID = 42220;
const POOL_ADDRESS = "0x00000000000000000000000000000000000000d0";
const TOKEN0 = "0x00000000000000000000000000000000000000d1";
const TOKEN1 = "0x00000000000000000000000000000000000000d2";
const INTERNAL_UNIT = 10n ** 15n; // TradingLimitsV2 15-decimal internal scale

function mockGetTradingLimits(
  token: string,
  limits: {
    limit0: bigint;
    limit1: bigint;
    netflow0: bigint;
    netflow1: bigint;
    lastUpdated0?: number;
    lastUpdated1?: number;
  },
): void {
  setHttpRpcMock({
    group: "tradingLimits",
    chainId: CHAIN_ID,
    address: POOL_ADDRESS,
    functionName: "getTradingLimits",
    callArgs: [token],
    result: [
      { limit0: limits.limit0, limit1: limits.limit1, decimals: 15 },
      {
        lastUpdated0: limits.lastUpdated0 ?? 100,
        lastUpdated1: limits.lastUpdated1 ?? 100,
        netflow0: limits.netflow0,
        netflow1: limits.netflow1,
      },
    ],
  });
}

function healedFpmmPool() {
  return makePool({
    id: makePoolId(CHAIN_ID, POOL_ADDRESS),
    chainId: CHAIN_ID,
    token0: TOKEN0,
    token1: TOKEN1,
    tokenDecimalsKnown: true,
    invertRateFeedKnown: true,
    source: "fpmm_factory",
    wrappedExchangeId: "",
    reserves0: 1_000_000n * 10n ** 18n,
    reserves1: 1_000_000n * 10n ** 18n,
    referenceRateFeedID: "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a",
    lpFee: 25,
    protocolFee: 15,
    rebalanceReward: 3,
  });
}

function swapEvent(logIndex: number, blockNumber: number) {
  const data: MockEventData = createMockEventData({
    chainId: CHAIN_ID,
    logIndex,
    srcAddress: POOL_ADDRESS,
    blockNumber,
    blockTimestamp: 1_700_000_000 + blockNumber,
  });
  return FPMM.Swap.createMockEvent({
    sender: TOKEN0,
    to: TOKEN1,
    amount0In: 1_000_000_000_000_000_000n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 2_000_000_000_000_000_000n,
    mockEventData: data,
  });
}

type TradingLimitRow = {
  limit0: bigint;
  limit1: bigint;
  netflow0: bigint;
  netflow1: bigint;
  lastUpdated0: bigint;
  lastUpdated1: bigint;
};

describe("Trading-limit config change mid-window (issue #1053 scenario 6)", () => {
  beforeEach(() => {
    _clearMockVpExchangeIds();
    _setMockVpExchangeId(CHAIN_ID, POOL_ADDRESS, null); // permanent "not a VP"
  });

  it("preserves accumulated netflow for its own key and leaves the other token's key untouched", async () => {
    // Distinct per-token state — token0 near its limit, token1 comfortably
    // inside its window with a negative netflow — proving the two keys
    // don't bleed into each other.
    mockGetTradingLimits(TOKEN0, {
      limit0: 1_000n * INTERNAL_UNIT,
      limit1: 0n,
      netflow0: 800n * INTERNAL_UNIT,
      netflow1: 0n,
    });
    mockGetTradingLimits(TOKEN1, {
      limit0: 500n * INTERNAL_UNIT,
      limit1: 500n * INTERNAL_UNIT,
      netflow0: 100n * INTERNAL_UNIT,
      netflow1: -50n * INTERNAL_UNIT,
    });

    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.Pool.set(healedFpmmPool());

    mockDb = await FPMM.Swap.processEvent({
      event: swapEvent(1, 200),
      mockDb,
    });

    const poolId = makePoolId(CHAIN_ID, POOL_ADDRESS);
    const token0IdBefore = tradingLimitId(poolId, TOKEN0);
    const token1IdBefore = tradingLimitId(poolId, TOKEN1);
    const token0Before = mockDb.entities.TradingLimit.get(
      token0IdBefore,
    ) as TradingLimitRow;
    const token1Before = mockDb.entities.TradingLimit.get(
      token1IdBefore,
    ) as TradingLimitRow;
    assert.ok(token0Before);
    assert.ok(token1Before);
    assert.equal(token0Before.netflow0, 800n * INTERNAL_UNIT);
    assert.equal(token1Before.netflow0, 100n * INTERNAL_UNIT);
    assert.equal(token1Before.netflow1, -50n * INTERNAL_UNIT);

    // Governance doubles token0's limit0 mid-window. limit1 stays enabled
    // (nonzero) too, so `resetTradingLimitState` must preserve BOTH sides'
    // netflow, not just reset both to 0.
    const configured = FPMM.TradingLimitConfigured.createMockEvent({
      token: TOKEN0,
      config: { limit0: 2_000n * INTERNAL_UNIT, limit1: 10n * INTERNAL_UNIT },
      mockEventData: createMockEventData({
        chainId: CHAIN_ID,
        logIndex: 2,
        srcAddress: POOL_ADDRESS,
        blockNumber: 300,
        blockTimestamp: 1_700_000_300,
      }),
    });
    mockDb = await FPMM.TradingLimitConfigured.processEvent({
      event: configured,
      mockDb,
    });

    const token0After = mockDb.entities.TradingLimit.get(
      token0IdBefore,
    ) as TradingLimitRow;
    assert.ok(token0After);
    assert.equal(token0After.limit0, 2_000n * INTERNAL_UNIT, "limit0 updates");
    assert.equal(token0After.limit1, 10n * INTERNAL_UNIT, "limit1 updates");
    assert.equal(
      token0After.netflow0,
      800n * INTERNAL_UNIT,
      "netflow0 must survive the config change (both new limits nonzero)",
    );
    assert.equal(
      token0After.netflow1,
      0n,
      "netflow1 stays at its prior (zero) value",
    );
    assert.equal(token0After.lastUpdated0, 0n, "window resets on reconfigure");
    assert.equal(token0After.lastUpdated1, 0n);

    // token1's row is a completely separate key — must be byte-identical
    // to its pre-reconfigure state.
    const token1After = mockDb.entities.TradingLimit.get(
      token1IdBefore,
    ) as TradingLimitRow;
    assert.deepEqual(token1After, token1Before);

    // Pool.limitStatus/limitPressure reflect the NEW config against the
    // PRESERVED netflow (800/2000 = 40% pressure on token0's window).
    const pool = mockDb.entities.Pool.get(poolId) as {
      limitStatus: string;
      limitPressure0: string;
    };
    assert.equal(pool.limitPressure0, "0.4000");
    assert.equal(pool.limitStatus, "OK");
  });
});
