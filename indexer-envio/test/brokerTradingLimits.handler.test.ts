import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";
import type { BrokerTradingLimit, Pool } from "envio";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import { createMockEventData } from "./helpers/eventFixtures.js";
import {
  clearHttpRpcMockGroup,
  httpRpcCallCount,
  resetHttpRpcCallCounts,
  setHttpRpcErrorMock,
  setHttpRpcMock,
} from "../src/rpc/http-test-mocks.js";
import {
  _clearMockFeeTokenMeta,
  _clearMockVpExchangeIds,
  _setMockFeeTokenMeta,
  _setMockVpExchangeId,
} from "../src/EventHandlers.ts";
import { makePool } from "./helpers/makePool.ts";
import { makePoolId } from "../src/helpers.ts";
import {
  LIMIT_FLAG_LG,
  brokerLimitId,
  brokerTradingLimitRowId,
} from "../src/brokerTradingLimits.ts";

// ---------------------------------------------------------------------------
// Broker trading limits end to end: Broker.Swap drives a block-pinned RPC read
// behind a freshness gate, Broker.TradingLimitConfigured drives config, and the
// worst leg lands on the wrapping VirtualPool's Pool row.
// ---------------------------------------------------------------------------

type MockDb = MockDbWith<{
  Pool: WritableEntity<Pool>;
  BrokerTradingLimit: EntityReader<BrokerTradingLimit>;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, Broker } = TestHelpers;

const CHAIN_ID = 42220;
const BROKER_PROXY = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const BIPOOL_MANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const EXCHANGE_ID =
  "0xd580d237231109e6a96d67d82450611c610a805a26660c90281bdc0cd04a95c7";
const UNWRAPPED_EXCHANGE_ID =
  "0x89de88b8eb790de26f4649f543cb6893d93635c728ac857f0926e842fb0d298b";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const AUDM = "0x7175504c455076f15c04a2f90a8e352281f492f9";
const VIRTUAL_POOL = "0x1d013077b00b28038a3f1e7a29aba34e12e562e9";
const SIGNER_EOA = "0xabcdef1234567890abcdef1234567890abcdef12";
const POOL_ID = makePoolId(CHAIN_ID, VIRTUAL_POOL);
const MOCK_GROUP = "brokerTradingLimits";

const USDM_LIMIT_ID = brokerLimitId(EXCHANGE_ID, USDM);
const AUDM_LIMIT_ID = brokerLimitId(EXCHANGE_ID, AUDM);

const START_TS = 1_757_000_000;
const START_BLOCK = 77_563_625;

type Windows = {
  netflowGlobal: bigint;
  limitGlobal?: bigint;
  flags?: number;
};

function mockLeg(limitId: string, windows: Windows): void {
  setHttpRpcMock({
    group: MOCK_GROUP,
    chainId: CHAIN_ID,
    address: BROKER_PROXY,
    functionName: "tradingLimitsState",
    callArgs: [limitId],
    result: [0, 0, 0, 0, windows.netflowGlobal],
  });
  setHttpRpcMock({
    group: MOCK_GROUP,
    chainId: CHAIN_ID,
    address: BROKER_PROXY,
    functionName: "tradingLimitsConfig",
    callArgs: [limitId],
    result: [
      0,
      0,
      0,
      0,
      windows.limitGlobal ?? 1597n,
      windows.flags ?? LIMIT_FLAG_LG,
    ],
  });
}

function failLeg(limitId: string, functionName: string): void {
  setHttpRpcErrorMock({
    group: MOCK_GROUP,
    chainId: CHAIN_ID,
    address: BROKER_PROXY,
    functionName,
    callArgs: [limitId],
  });
}

function stateCalls(): number {
  return httpRpcCallCount(CHAIN_ID, BROKER_PROXY, "tradingLimitsState");
}

function configCalls(): number {
  return httpRpcCallCount(CHAIN_ID, BROKER_PROXY, "tradingLimitsConfig");
}

function virtualPoolRow(): Pool {
  return makePool({
    id: POOL_ID,
    chainId: CHAIN_ID,
    token0: USDM,
    token1: AUDM,
    source: "virtual_pool_factory",
    wrappedExchangeId: EXCHANGE_ID,
    tokenDecimalsKnown: true,
    invertRateFeedKnown: true,
  });
}

async function fireSwap(
  mockDb: MockDb,
  args: {
    blockNumber?: number;
    blockTimestamp?: number;
    logIndex?: number;
    exchangeId?: string;
    brokerCaller?: string;
  } = {},
): Promise<MockDb> {
  const event = Broker.Swap.createMockEvent({
    exchangeProvider: BIPOOL_MANAGER,
    exchangeId: args.exchangeId ?? EXCHANGE_ID,
    trader: args.brokerCaller ?? SIGNER_EOA,
    tokenIn: USDM,
    tokenOut: AUDM,
    amountIn: 10n ** 18n,
    amountOut: 10n ** 18n,
    mockEventData: createMockEventData({
      chainId: CHAIN_ID,
      logIndex: args.logIndex ?? 0,
      srcAddress: BROKER_PROXY,
      blockNumber: args.blockNumber ?? START_BLOCK,
      blockTimestamp: args.blockTimestamp ?? START_TS,
      transaction: { from: SIGNER_EOA, to: BROKER_PROXY },
    }),
  });
  return Broker.Swap.processEvent({ event, mockDb });
}

async function fireConfigured(
  mockDb: MockDb,
  args: {
    token: string;
    limitGlobal: bigint;
    flags: number;
    blockNumber?: number;
    blockTimestamp?: number;
  },
): Promise<MockDb> {
  const event = Broker.TradingLimitConfigured.createMockEvent({
    exchangeId: EXCHANGE_ID,
    token: args.token,
    config: {
      timestep0: 0n,
      timestep1: 0n,
      limit0: 0n,
      limit1: 0n,
      limitGlobal: args.limitGlobal,
      flags: BigInt(args.flags),
    },
    mockEventData: createMockEventData({
      chainId: CHAIN_ID,
      logIndex: 1,
      srcAddress: BROKER_PROXY,
      blockNumber: args.blockNumber ?? START_BLOCK + 10,
      blockTimestamp: args.blockTimestamp ?? START_TS + 10,
    }),
  });
  return Broker.TradingLimitConfigured.processEvent({ event, mockDb });
}

function legRow(mockDb: MockDb, token: string): BrokerTradingLimit | undefined {
  return mockDb.entities.BrokerTradingLimit.get(
    brokerTradingLimitRowId(CHAIN_ID, EXCHANGE_ID, token),
  );
}

function seededDb(): MockDb {
  const mockDb = MockDb.createMockDb();
  return mockDb.entities.Pool.set(virtualPoolRow());
}

describe("Broker trading limits", () => {
  beforeEach(() => {
    clearHttpRpcMockGroup(MOCK_GROUP);
    resetHttpRpcCallCounts();
    _clearMockFeeTokenMeta();
    _clearMockVpExchangeIds();
    _setMockFeeTokenMeta(CHAIN_ID, USDM, { symbol: "USDm", decimals: 18 });
    _setMockFeeTokenMeta(CHAIN_ID, AUDM, { symbol: "AUDm", decimals: 18 });
    _setMockVpExchangeId(CHAIN_ID, VIRTUAL_POOL, {
      exchangeProvider: BIPOOL_MANAGER,
      exchangeId: EXCHANGE_ID,
    });
    _setMockVpExchangeId(CHAIN_ID, SIGNER_EOA, null);
    mockLeg(USDM_LIMIT_ID, { netflowGlobal: 1139n, limitGlobal: 1144n });
    mockLeg(AUDM_LIMIT_ID, { netflowGlobal: -1596n, limitGlobal: 1597n });
  });

  it("writes both legs and folds the worst window onto the VirtualPool", async () => {
    const mockDb = await fireSwap(seededDb());

    const usdm = legRow(mockDb, USDM);
    const audm = legRow(mockDb, AUDM);
    assert.ok(usdm);
    assert.ok(audm);
    assert.equal(usdm.limitId, USDM_LIMIT_ID);
    assert.equal(usdm.poolId, POOL_ID);
    assert.equal(usdm.exchangeProvider, BIPOOL_MANAGER);
    assert.equal(usdm.configKnown, true);
    assert.equal(usdm.stateKnown, true);
    assert.equal(usdm.netflowGlobal, 1139n);
    assert.equal(usdm.limitGlobal, 1144n);
    assert.equal(usdm.limitPressureGlobal, "0.9956");
    assert.equal(audm.netflowGlobal, -1596n);
    assert.equal(audm.limitPressureGlobal, "0.9994");
    assert.equal(audm.stateBlock, BigInt(START_BLOCK));
    assert.equal(audm.stateTimestamp, BigInt(START_TS));

    const pool = mockDb.entities.Pool.get(POOL_ID);
    assert.equal(pool?.limitStatus, "WARN");
    assert.equal(pool?.limitPressure0, "0.9956");
    assert.equal(pool?.limitPressure1, "0.9994");
  });

  it("requests the same effect key in preload and processing", async () => {
    await fireSwap(seededDb());

    // Envio dedupes identical effect inputs across the two passes. Two legs at
    // two reads each (state + config bootstrap) is the whole budget; a key
    // that differed between passes would double these counts.
    assert.equal(stateCalls(), 2);
    assert.equal(configCalls(), 2);
  });

  it("reads config only once, then state alone on later refreshes", async () => {
    const mockDb = await fireSwap(seededDb());
    resetHttpRpcCallCounts();

    await fireSwap(mockDb, {
      blockNumber: START_BLOCK + 200,
      blockTimestamp: START_TS + 400,
      logIndex: 1,
    });

    assert.equal(stateCalls(), 2);
    assert.equal(configCalls(), 0);
  });

  it("skips the read entirely inside the refresh window", async () => {
    mockLeg(USDM_LIMIT_ID, { netflowGlobal: 100n, limitGlobal: 1144n });
    mockLeg(AUDM_LIMIT_ID, { netflowGlobal: 100n, limitGlobal: 1597n });
    let mockDb = await fireSwap(seededDb());
    resetHttpRpcCallCounts();

    mockDb = await fireSwap(mockDb, {
      blockNumber: START_BLOCK + 30,
      blockTimestamp: START_TS + 60,
      logIndex: 1,
    });

    assert.equal(stateCalls(), 0);
    assert.equal(configCalls(), 0);
    assert.equal(legRow(mockDb, AUDM)?.stateTimestamp, BigInt(START_TS));
  });

  it("refreshes once the state reaches the refresh window", async () => {
    mockLeg(USDM_LIMIT_ID, { netflowGlobal: 100n, limitGlobal: 1144n });
    mockLeg(AUDM_LIMIT_ID, { netflowGlobal: 100n, limitGlobal: 1597n });
    let mockDb = await fireSwap(seededDb());
    resetHttpRpcCallCounts();
    mockLeg(AUDM_LIMIT_ID, { netflowGlobal: 200n, limitGlobal: 1597n });

    mockDb = await fireSwap(mockDb, {
      blockNumber: START_BLOCK + 200,
      blockTimestamp: START_TS + 400,
      logIndex: 1,
    });

    assert.equal(stateCalls(), 2);
    assert.equal(legRow(mockDb, AUDM)?.netflowGlobal, 200n);
    assert.equal(legRow(mockDb, AUDM)?.stateTimestamp, BigInt(START_TS + 400));
  });

  it("re-reads a hot leg on every swap, inside the window", async () => {
    // 1360/1597 = 0.85 — above the 0.8 hot threshold.
    mockLeg(USDM_LIMIT_ID, { netflowGlobal: 100n, limitGlobal: 1144n });
    mockLeg(AUDM_LIMIT_ID, { netflowGlobal: 1360n, limitGlobal: 1597n });
    let mockDb = await fireSwap(seededDb());
    resetHttpRpcCallCounts();

    mockDb = await fireSwap(mockDb, {
      blockNumber: START_BLOCK + 1,
      blockTimestamp: START_TS + 2,
      logIndex: 1,
    });

    // Only the hot AUDm leg is re-read; the calm USDm leg stays gated.
    assert.equal(stateCalls(), 1);
    assert.equal(legRow(mockDb, AUDM)?.stateBlock, BigInt(START_BLOCK + 1));
    assert.equal(legRow(mockDb, USDM)?.stateBlock, BigInt(START_BLOCK));
  });

  it("reads once for two swaps in the same block", async () => {
    const mockDb = await fireSwap(seededDb());
    resetHttpRpcCallCounts();

    await fireSwap(mockDb, { logIndex: 1 });

    assert.equal(stateCalls(), 0);
    assert.equal(configCalls(), 0);
  });

  it("folds onto the pool once its tokens land, with no fresh read", async () => {
    // The first swap can land before the pool mirrors token0/token1, which
    // folds to N/A. Nothing else re-folds, so the next swap must, even inside
    // the refresh window where it reads nothing.
    // Cool legs, so the second swap is inside the refresh window and reads
    // nothing — the re-fold cannot be riding on a fresh read.
    mockLeg(USDM_LIMIT_ID, { netflowGlobal: 100n, limitGlobal: 1144n });
    mockLeg(AUDM_LIMIT_ID, { netflowGlobal: 100n, limitGlobal: 1597n });
    let mockDb = seededDb().entities.Pool.set({
      ...virtualPoolRow(),
      token0: undefined,
      token1: undefined,
    });
    mockDb = await fireSwap(mockDb);
    assert.equal(mockDb.entities.Pool.get(POOL_ID)?.limitStatus, "N/A");
    resetHttpRpcCallCounts();

    mockDb = mockDb.entities.Pool.set({
      ...mockDb.entities.Pool.get(POOL_ID)!,
      token0: USDM,
      token1: AUDM,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: START_BLOCK + 1,
      blockTimestamp: START_TS + 2,
      logIndex: 1,
    });

    assert.equal(stateCalls(), 0);
    assert.equal(configCalls(), 0);
    const pool = mockDb.entities.Pool.get(POOL_ID);
    assert.equal(pool?.limitStatus, "OK");
    assert.equal(pool?.limitPressure0, "0.0874");
    assert.equal(pool?.limitPressure1, "0.0626");
  });

  it("updates the same rows for a VirtualPool-routed swap", async () => {
    const mockDb = await fireSwap(seededDb(), {
      brokerCaller: VIRTUAL_POOL,
    });

    assert.equal(legRow(mockDb, AUDM)?.netflowGlobal, -1596n);
    assert.equal(mockDb.entities.Pool.get(POOL_ID)?.limitStatus, "WARN");
  });

  it("writes nothing for an exchange no VirtualPool wraps", async () => {
    mockLeg(brokerLimitId(UNWRAPPED_EXCHANGE_ID, USDM), {
      netflowGlobal: 1n,
    });
    mockLeg(brokerLimitId(UNWRAPPED_EXCHANGE_ID, AUDM), {
      netflowGlobal: 1n,
    });
    resetHttpRpcCallCounts();

    const mockDb = await fireSwap(seededDb(), {
      exchangeId: UNWRAPPED_EXCHANGE_ID,
    });

    assert.equal(
      mockDb.entities.BrokerTradingLimit.get(
        brokerTradingLimitRowId(CHAIN_ID, UNWRAPPED_EXCHANGE_ID, USDM),
      ),
      undefined,
    );
    assert.equal(stateCalls(), 0);
    assert.equal(mockDb.entities.Pool.get(POOL_ID)?.limitStatus, "N/A");
  });

  it("leaves an existing row untouched when the read fails", async () => {
    let mockDb = await fireSwap(seededDb());
    const before = legRow(mockDb, AUDM);
    failLeg(AUDM_LIMIT_ID, "tradingLimitsState");

    mockDb = await fireSwap(mockDb, {
      blockNumber: START_BLOCK + 200,
      blockTimestamp: START_TS + 400,
      logIndex: 1,
    });

    assert.deepEqual(legRow(mockDb, AUDM), before);
    // The USDm leg still refreshed, so the Pool keeps a real status.
    assert.equal(mockDb.entities.Pool.get(POOL_ID)?.limitStatus, "WARN");
  });

  it("writes an unknown placeholder when the first read fails", async () => {
    failLeg(USDM_LIMIT_ID, "tradingLimitsState");
    failLeg(AUDM_LIMIT_ID, "tradingLimitsState");

    const mockDb = await fireSwap(seededDb());

    const audm = legRow(mockDb, AUDM);
    assert.ok(audm);
    assert.equal(audm.configKnown, false);
    assert.equal(audm.stateKnown, false);
    assert.equal(audm.limitStatus, "N/A");
    assert.equal(audm.stateBlock, 0n);
    assert.equal(mockDb.entities.Pool.get(POOL_ID)?.limitStatus, "N/A");
  });

  it("applies TradingLimitConfigured with no RPC and re-folds the pool", async () => {
    let mockDb = await fireSwap(seededDb());
    resetHttpRpcCallCounts();

    mockDb = await fireConfigured(mockDb, {
      token: AUDM,
      limitGlobal: 4000n,
      flags: LIMIT_FLAG_LG,
    });

    assert.equal(stateCalls(), 0);
    assert.equal(configCalls(), 0);
    const audm = legRow(mockDb, AUDM);
    assert.equal(audm?.limitGlobal, 4000n);
    assert.equal(audm?.configKnown, true);
    // LG stays flagged, so reset() keeps its netflow.
    assert.equal(audm?.netflowGlobal, -1596n);
    assert.equal(audm?.lastUpdated0, 0n);
    assert.equal(audm?.limitPressureGlobal, "0.3990");
    assert.equal(audm?.stateTimestamp, 0n);

    const pool = mockDb.entities.Pool.get(POOL_ID);
    // The other leg keeps its pressure through the re-fold.
    assert.equal(pool?.limitPressure0, "0.9956");
    assert.equal(pool?.limitPressure1, "0.3990");
    assert.equal(pool?.limitStatus, "WARN");
  });

  it("zeroes the netflow of a window the reconfigure disables", async () => {
    let mockDb = await fireSwap(seededDb());

    mockDb = await fireConfigured(mockDb, {
      token: AUDM,
      limitGlobal: 0n,
      flags: 0,
    });

    const audm = legRow(mockDb, AUDM);
    assert.equal(audm?.netflowGlobal, 0n);
    assert.equal(audm?.limitStatus, "N/A");
  });

  it("makes the next swap re-read after a reconfigure", async () => {
    let mockDb = await fireSwap(seededDb());
    mockDb = await fireConfigured(mockDb, {
      token: AUDM,
      limitGlobal: 4000n,
      flags: LIMIT_FLAG_LG,
    });
    resetHttpRpcCallCounts();
    mockLeg(AUDM_LIMIT_ID, { netflowGlobal: -1700n, limitGlobal: 4000n });

    mockDb = await fireSwap(mockDb, {
      blockNumber: START_BLOCK + 20,
      blockTimestamp: START_TS + 30,
      logIndex: 2,
    });

    // Both legs read: the reconfigured AUDm leg because its stored state is
    // stale by definition, the USDm leg because it sits above 0.8 pressure.
    assert.equal(stateCalls(), 2);
    assert.equal(configCalls(), 0);
    assert.equal(legRow(mockDb, AUDM)?.netflowGlobal, -1700n);
  });

  it("ignores a TradingLimitConfigured for an unwrapped exchange", async () => {
    const mockDb = await fireConfigured(MockDb.createMockDb(), {
      token: AUDM,
      limitGlobal: 4000n,
      flags: LIMIT_FLAG_LG,
    });

    assert.equal(legRow(mockDb, AUDM), undefined);
  });
});
