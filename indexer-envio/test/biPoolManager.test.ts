import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
  type MockEventData,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import { createMockEventData } from "./helpers/eventFixtures.js";
import {
  _setMockPoolExchange,
  _clearMockPoolExchanges,
  _setMockVpExchangeId,
  _clearMockVpExchangeIds,
  _clearMockERC20Decimals,
  _setMockTokenDecimalsScaling,
  _clearMockTokenDecimalsScaling,
} from "../src/EventHandlers.ts";
import {
  extractVpExchangeIdFromBytecode,
  fetchPoolExchange,
  fetchVirtualPoolExchangeId,
  VP_PROBE_RPC_ERROR,
  type PoolExchangeStruct,
} from "../src/rpc/biPoolManager.ts";
import { fetchTokenDecimalsScaling } from "../src/rpc/pool-state.ts";
import { _setRpcClientForTests, _testHooks } from "../src/rpc.ts";
import { _clearPricingModuleIndex } from "../src/contractAddresses.ts";
import { isVirtualPool, makePoolId } from "../src/helpers.ts";

type MockDb = MockDbWith<{
  Pool: WritableEntity;
  BiPoolExchange: WritableEntity;
  BucketUpdate: EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, BiPoolManager, VirtualPoolFactory, VirtualPool } = TestHelpers;

const CHAIN_ID = 42220; // Celo mainnet — pricingModule index resolves here.
const BIPOOL_MANAGER_ADDRESS = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const ASSET0 = "0x00000000000000000000000000000000000000a0";
const ASSET1 = "0x00000000000000000000000000000000000000a1";
const FEED_ID = "0x000000000000000000000000000000000000beef";
const EXCHANGE_ID = "0x" + "11".repeat(32); // bytes32 — 64 hex chars

// Celo mainnet ConstantSumPricingModule from @mento-protocol/contracts.
// Used to assert the pricingModuleName resolver returns "ConstantSum".
const CONSTANT_SUM_MAINNET = "0xdebed1f6f6ce9f6e73aa25f95acbffe2397550fb";

const VP_ADDRESS = "0x000000000000000000000000000000000000beef";

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function mockVpTokenDecimalsScaling(): void {
  _setMockTokenDecimalsScaling(CHAIN_ID, VP_ADDRESS, "decimals0", 10n ** 6n);
  _setMockTokenDecimalsScaling(CHAIN_ID, VP_ADDRESS, "decimals1", 10n ** 18n);
}

function exchangeRowId(exchangeId: string): string {
  return `${CHAIN_ID}-${exchangeId.toLowerCase()}`;
}

function mockEventData(
  logIndex: number,
  blockNumber: number,
  blockTs: number,
  srcAddress: string = BIPOOL_MANAGER_ADDRESS,
): MockEventData {
  return createMockEventData({
    chainId: CHAIN_ID,
    logIndex,
    srcAddress,
    blockNumber,
    blockTimestamp: blockTs,
  });
}

function fullStruct(): PoolExchangeStruct {
  return {
    asset0: ASSET0,
    asset1: ASSET1,
    pricingModule: CONSTANT_SUM_MAINNET,
    bucket0: 1_000_000n,
    bucket1: 2_000_000n,
    lastBucketUpdate: 1_700_001_000n,
    spread: 5n * 10n ** 21n, // 50bps in FixidityLib 1e24
    referenceRateFeedID: FEED_ID,
    referenceRateResetFrequency: 360n,
    minimumReports: 3n,
    stablePoolResetSize: 100_000n,
  };
}

function rpcPoolExchangeResult(): {
  asset0: string;
  asset1: string;
  pricingModule: string;
  bucket0: bigint;
  bucket1: bigint;
  lastBucketUpdate: bigint;
  config: {
    spread: { value: bigint };
    referenceRateFeedID: string;
    referenceRateResetFrequency: bigint;
    minimumReports: bigint;
    stablePoolResetSize: bigint;
  };
} {
  const struct = fullStruct();
  return {
    asset0: struct.asset0,
    asset1: struct.asset1,
    pricingModule: struct.pricingModule,
    bucket0: struct.bucket0,
    bucket1: struct.bucket1,
    lastBucketUpdate: struct.lastBucketUpdate,
    config: {
      spread: { value: struct.spread },
      referenceRateFeedID: struct.referenceRateFeedID,
      referenceRateResetFrequency: struct.referenceRateResetFrequency,
      minimumReports: struct.minimumReports,
      stablePoolResetSize: struct.stablePoolResetSize,
    },
  };
}

describe("BiPoolManager handlers", () => {
  beforeEach(() => {
    _clearMockPoolExchanges();
    _clearMockVpExchangeIds();
    _clearMockERC20Decimals();
    _clearMockTokenDecimalsScaling();
    _setRpcClientForTests(CHAIN_ID, null);
    _clearPricingModuleIndex();
  });

  describe("fetchPoolExchange", () => {
    it("reads getPoolExchange at the supplied event block", async () => {
      const calls: unknown[] = [];
      const blockNumber = 123_456n;
      _setRpcClientForTests(CHAIN_ID, {
        readContract: async (args) => {
          calls.push(args);
          return rpcPoolExchangeResult();
        },
      });

      const result = await fetchPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        blockNumber,
        noopLogger,
      );

      assert.ok(result);
      assert.equal(calls.length, 1);
      assert.equal(
        (calls[0] as { functionName: string }).functionName,
        "getPoolExchange",
      );
      assert.equal(
        (calls[0] as { blockNumber?: bigint }).blockNumber,
        blockNumber,
      );
    });

    it("returns null instead of accepting a latest-block fallback", async () => {
      const originalDelayFn = _testHooks.delayFn;
      _testHooks.delayFn = async () => {};

      const calls: unknown[] = [];
      const blockNumber = 123_456n;
      _setRpcClientForTests(CHAIN_ID, {
        readContract: async (args) => {
          calls.push(args);
          if ((args as { blockNumber?: bigint }).blockNumber === blockNumber) {
            throw new Error("header not found");
          }
          return rpcPoolExchangeResult();
        },
      });

      try {
        const result = await fetchPoolExchange(
          CHAIN_ID,
          BIPOOL_MANAGER_ADDRESS,
          EXCHANGE_ID,
          blockNumber,
          noopLogger,
        );

        assert.equal(result, null);
        assert.equal(calls.length, 5);
        assert.equal(
          (calls.at(-1) as { blockNumber?: bigint }).blockNumber,
          undefined,
        );
      } finally {
        _testHooks.delayFn = originalDelayFn;
      }
    });
  });

  describe("ExchangeCreated", () => {
    it("populates BiPoolExchange from RPC backfill struct + resolves pricingModuleName", async function () {
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );

      let mockDb = MockDb.createMockDb();
      const event = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event,
        mockDb,
      });

      const row = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | {
            id: string;
            chainId: number;
            exchangeId: string;
            exchangeProvider: string;
            asset0: string;
            asset1: string;
            pricingModule: string;
            pricingModuleName?: string;
            spread: bigint;
            referenceRateFeedID: string;
            referenceRateResetFrequency: bigint;
            minimumReports: bigint;
            stablePoolResetSize: bigint;
            bucket0: bigint;
            bucket1: bigint;
            lastBucketUpdate: bigint;
            isDeprecated: boolean;
            wrappedByPoolId?: string;
            wrappedByPoolIdChecked: boolean;
          }
        | undefined;
      assert.ok(row, "BiPoolExchange row should be created");
      assert.equal(row!.exchangeId, EXCHANGE_ID.toLowerCase());
      assert.equal(row!.exchangeProvider, BIPOOL_MANAGER_ADDRESS);
      assert.equal(row!.asset0, ASSET0);
      assert.equal(row!.asset1, ASSET1);
      assert.equal(row!.pricingModule, CONSTANT_SUM_MAINNET);
      assert.equal(row!.pricingModuleName, "ConstantSum");
      assert.equal(row!.spread, 5n * 10n ** 21n);
      assert.equal(row!.referenceRateFeedID, FEED_ID);
      assert.equal(row!.referenceRateResetFrequency, 360n);
      assert.equal(row!.minimumReports, 3n);
      assert.equal(row!.bucket0, 1_000_000n);
      assert.equal(row!.bucket1, 2_000_000n);
      assert.equal(row!.lastBucketUpdate, 1_700_001_000n);
      assert.equal(row!.isDeprecated, false);
      assert.equal(row!.wrappedByPoolId, undefined);
      assert.equal(row!.wrappedByPoolIdChecked, true);
    });

    it("falls through to event params + zero stubs when RPC backfill fails", async function () {
      // Mock null = RPC failure simulation
      _setMockPoolExchange(CHAIN_ID, BIPOOL_MANAGER_ADDRESS, EXCHANGE_ID, null);

      let mockDb = MockDb.createMockDb();
      const event = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event,
        mockDb,
      });

      const row = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | {
            asset0: string;
            spread: bigint;
            referenceRateFeedID: string;
            bucket0: bigint;
            pricingModuleName?: string;
            wrappedByPoolIdChecked: boolean;
          }
        | undefined;
      assert.ok(row);
      // asset0/asset1/pricingModule come from event params even on RPC failure.
      assert.equal(row!.asset0, ASSET0);
      // pricingModuleName still resolves from the event-params address.
      assert.equal(row!.pricingModuleName, "ConstantSum");
      // Struct-only fields fall to zero sentinels.
      assert.equal(row!.spread, 0n);
      assert.equal(
        row!.referenceRateFeedID,
        "0x0000000000000000000000000000000000000000",
      );
      assert.equal(row!.bucket0, 0n);
      assert.equal(row!.wrappedByPoolIdChecked, true);
    });
  });

  describe("ExchangeDestroyed", () => {
    it("sets isDeprecated=true on existing row", async function () {
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      let mockDb = MockDb.createMockDb();
      const create = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event: create,
        mockDb,
      });

      const destroy = BiPoolManager.ExchangeDestroyed.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(1, 200, 1_700_001_000),
      });
      mockDb = await BiPoolManager.ExchangeDestroyed.processEvent({
        event: destroy,
        mockDb,
      });

      const row = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as { isDeprecated: boolean; updatedAtBlock: bigint } | undefined;
      assert.ok(row);
      assert.equal(row!.isDeprecated, true);
      assert.equal(row!.updatedAtBlock, 200n);
    });

    it("seeds a deprecated row from event params when no existing row exists", async function () {
      const mockDb = MockDb.createMockDb();
      const event = BiPoolManager.ExchangeDestroyed.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      const next = await BiPoolManager.ExchangeDestroyed.processEvent({
        event,
        mockDb,
      });
      const row = next.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | {
            isDeprecated: boolean;
            asset0: string;
            asset1: string;
            pricingModule: string;
            pricingModuleName?: string;
            referenceRateFeedID: string;
            spread: bigint;
            wrappedByPoolId?: string;
            wrappedByPoolIdChecked: boolean;
          }
        | undefined;
      assert.ok(
        row,
        "ExchangeDestroyed should seed a deprecated row when ExchangeCreated fired pre-start_block",
      );
      assert.equal(row!.isDeprecated, true);
      assert.equal(row!.asset0, ASSET0);
      assert.equal(row!.asset1, ASSET1);
      assert.equal(row!.pricingModule, CONSTANT_SUM_MAINNET);
      assert.equal(row!.pricingModuleName, "ConstantSum");
      // Config sentinels (Destroyed event doesn't carry these and
      // getPoolExchange reverts on a destroyed exchange).
      assert.equal(
        row!.referenceRateFeedID,
        "0x0000000000000000000000000000000000000000",
      );
      assert.equal(row!.spread, 0n);
      // No matching VP self-healed yet → wrappedByPoolId stays undefined.
      assert.equal(row!.wrappedByPoolId, undefined);
      assert.equal(row!.wrappedByPoolIdChecked, true);
    });
  });

  describe("BucketsUpdated", () => {
    it("appends a BucketUpdate row + denormalizes onto BiPoolExchange", async function () {
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      let mockDb = MockDb.createMockDb();
      const create = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event: create,
        mockDb,
      });

      const update = BiPoolManager.BucketsUpdated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        bucket0: 9_000_000n,
        bucket1: 18_000_000n,
        mockEventData: mockEventData(2, 300, 1_700_002_000),
      });
      mockDb = await BiPoolManager.BucketsUpdated.processEvent({
        event: update,
        mockDb,
      });

      // BucketUpdate (per-event time-series row)
      const updateRow = mockDb.entities.BucketUpdate.get(
        `${CHAIN_ID}_300_2`,
      ) as
        | {
            exchangeId: string;
            bucket0: bigint;
            bucket1: bigint;
            blockTimestamp: bigint;
          }
        | undefined;
      assert.ok(updateRow, "BucketUpdate row should be created");
      assert.equal(updateRow!.bucket0, 9_000_000n);
      assert.equal(updateRow!.bucket1, 18_000_000n);
      assert.equal(updateRow!.blockTimestamp, 1_700_002_000n);

      // Denormalized snapshot on BiPoolExchange
      const exchange = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | {
            bucket0: bigint;
            bucket1: bigint;
            lastBucketUpdate: bigint;
            updatedAtBlock: bigint;
          }
        | undefined;
      assert.ok(exchange);
      assert.equal(exchange!.bucket0, 9_000_000n);
      assert.equal(exchange!.bucket1, 18_000_000n);
      assert.equal(exchange!.lastBucketUpdate, 1_700_002_000n);
      assert.equal(exchange!.updatedAtBlock, 300n);
    });

    it("marks self-healed v2-only exchanges as wrapper-checked", async function () {
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      let mockDb = MockDb.createMockDb();

      const update = BiPoolManager.BucketsUpdated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        bucket0: 9_000_000n,
        bucket1: 18_000_000n,
        mockEventData: mockEventData(2, 300, 1_700_002_000),
      });
      mockDb = await BiPoolManager.BucketsUpdated.processEvent({
        event: update,
        mockDb,
      });

      const exchange = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | {
            wrappedByPoolId?: string;
            wrappedByPoolIdChecked: boolean;
          }
        | undefined;
      assert.ok(exchange);
      assert.equal(exchange!.wrappedByPoolId, undefined);
      assert.equal(exchange!.wrappedByPoolIdChecked, true);
    });
  });

  describe("SpreadUpdated", () => {
    it("updates spread on the existing row", async function () {
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      let mockDb = MockDb.createMockDb();
      const create = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event: create,
        mockDb,
      });

      const newSpread = 25n * 10n ** 20n; // 25bps
      const update = BiPoolManager.SpreadUpdated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        spread: newSpread,
        mockEventData: mockEventData(3, 400, 1_700_003_000),
      });
      mockDb = await BiPoolManager.SpreadUpdated.processEvent({
        event: update,
        mockDb,
      });

      const row = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as { spread: bigint; updatedAtBlock: bigint } | undefined;
      assert.ok(row);
      assert.equal(row!.spread, newSpread);
      assert.equal(row!.updatedAtBlock, 400n);
    });
  });

  describe("Pool ↔ BiPoolExchange wrappedByPoolId join", () => {
    it("BiPoolManager.ExchangeCreated back-references a pre-existing VP and copies feedID onto the Pool", async function () {
      // Step 1: VP deploys first (rare but possible). Bytecode extractor mock
      // returns the exchangeId; struct backfill mock omitted because
      // BiPoolExchange doesn't exist yet — the VP handler should still
      // persist `Pool.wrappedExchangeId`.
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      mockVpTokenDecimalsScaling();

      let mockDb = MockDb.createMockDb();
      const deploy = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
        pool: VP_ADDRESS,
        token0: ASSET0,
        token1: ASSET1,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await VirtualPoolFactory.VirtualPoolDeployed.processEvent({
        event: deploy,
        mockDb,
      });
      const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
      const pool0 = mockDb.entities.Pool.get(poolId) as
        | { wrappedExchangeId?: string; referenceRateFeedID: string }
        | undefined;
      assert.ok(pool0);
      assert.equal(pool0!.wrappedExchangeId, EXCHANGE_ID.toLowerCase());
      // No BiPoolExchange yet → no feedID known, so referenceRateFeedID stays empty.
      assert.equal(pool0!.referenceRateFeedID, "");

      // Step 2: ExchangeCreated fires later. Should set wrappedByPoolId AND
      // copy the feedID onto the existing Pool.
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      const create = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(1, 200, 1_700_001_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event: create,
        mockDb,
      });

      const exchange = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as { wrappedByPoolId?: string } | undefined;
      assert.ok(exchange);
      assert.equal(exchange!.wrappedByPoolId, poolId);

      const pool1 = mockDb.entities.Pool.get(poolId) as
        | { referenceRateFeedID: string }
        | undefined;
      assert.ok(pool1);
      assert.equal(pool1!.referenceRateFeedID, FEED_ID);
    });

    it("repairs a checked exchange-first row that missed the VP back-reference once the Pool is otherwise fully healed", async function () {
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      mockVpTokenDecimalsScaling();

      let mockDb = MockDb.createMockDb();
      const create = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event: create,
        mockDb,
      });

      const deploy = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
        pool: VP_ADDRESS,
        token0: ASSET0,
        token1: ASSET1,
        mockEventData: mockEventData(1, 200, 1_700_001_000),
      });
      mockDb = await VirtualPoolFactory.VirtualPoolDeployed.processEvent({
        event: deploy,
        mockDb,
      });

      const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
      const poolBefore = mockDb.entities.Pool.get(poolId) as
        | {
            token0?: string;
            token1?: string;
            wrappedExchangeId?: string;
          }
        | undefined;
      assert.ok(poolBefore);
      assert.equal(poolBefore!.token0, ASSET0);
      assert.equal(poolBefore!.token1, ASSET1);
      assert.equal(poolBefore!.wrappedExchangeId, EXCHANGE_ID.toLowerCase());

      const linkedExchange = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | {
            wrappedByPoolId?: string;
            wrappedByPoolIdChecked: boolean;
            [key: string]: unknown;
          }
        | undefined;
      assert.ok(linkedExchange);
      assert.equal(linkedExchange!.wrappedByPoolId, poolId);

      // Simulate the historical exchange-first negative sentinel state:
      // the Pool is fully healed, but the exchange row was checked before
      // the VP back-reference was visible. The next VP event must not
      // short-circuit just because both sides otherwise look populated.
      mockDb = mockDb.entities.BiPoolExchange.set({
        ...linkedExchange!,
        wrappedByPoolId: undefined,
        wrappedByPoolIdChecked: true,
      });

      const swap = VirtualPool.Swap.createMockEvent({
        sender: ASSET0,
        amount0In: 1_000_000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 990_000n,
        to: ASSET1,
        mockEventData: mockEventData(2, 300, 1_700_002_000, VP_ADDRESS),
      });
      mockDb = await VirtualPool.Swap.processEvent({ event: swap, mockDb });

      const repairedExchange = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | { wrappedByPoolId?: string; wrappedByPoolIdChecked: boolean }
        | undefined;
      assert.ok(repairedExchange);
      assert.equal(repairedExchange!.wrappedByPoolId, poolId);
      assert.equal(repairedExchange!.wrappedByPoolIdChecked, true);
    });

    it("self-heals wrappedExchangeId when first event is VirtualPool.Swap (fpmm_* source override)", async function () {
      // Pre-start_block VP scenario: VirtualPoolDeployed fired before our
      // start_block, so the factory handler never ran. The first event we
      // observe for this VP is `VirtualPool.Swap`, which calls upsertPool
      // with `source: "fpmm_swap"` (intentional reuse — VP swap shares
      // priority with FPMM swap for `pickPreferredSource`).
      //
      // Before the source-gate refactor, `selfHealWrappedExchangeId` gated
      // on `isVirtualPool(pool)` (which checks `pool.source.includes("virtual")`),
      // so a VP with `source = "fpmm_swap"` would be treated as an FPMM
      // and the heal would be skipped → `wrappedExchangeId` stayed empty
      // forever. The bytecode-pattern detector (`vpExchangeIdEffect`) is
      // now the authoritative VP test, so the heal runs regardless of
      // the source string.
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      // Mock pool-exchange to null so the round 3 inline seed bails fast
      // instead of hitting real RPC (the seed succeeding isn't what this
      // test exercises). Without this, the CI runner sees viem retries +
      // backoff (~10s) for the unmocked `poolExchangeEffect` call.
      _setMockPoolExchange(CHAIN_ID, BIPOOL_MANAGER_ADDRESS, EXCHANGE_ID, null);

      let mockDb = MockDb.createMockDb();
      const swap = VirtualPool.Swap.createMockEvent({
        sender: ASSET0,
        amount0In: 1_000_000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 990_000n,
        to: ASSET1,
        mockEventData: mockEventData(0, 100, 1_700_000_000, VP_ADDRESS),
      });
      mockDb = await VirtualPool.Swap.processEvent({ event: swap, mockDb });

      const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
      const pool = mockDb.entities.Pool.get(poolId) as
        | { source: string; wrappedExchangeId?: string }
        | undefined;
      assert.ok(pool);
      // Source stamps as fpmm_swap (the gate-bypass under test) — without
      // the refactor, the next assertion would fail because the source
      // gate would have skipped the heal.
      assert.equal(pool!.source, "fpmm_swap");
      assert.equal(pool!.wrappedExchangeId, EXCHANGE_ID.toLowerCase());
    });

    it("backfills token0/token1 + decimals from BiPoolExchange when first event is VirtualPool.Swap", async function () {
      // Codex P2 #3 follow-up: in the pre-start_block scenario above, the
      // Pool is created via `getOrCreate` without `defaults.token0/token1`
      // (Swap/Mint/Burn events don't carry the pair). Without backfill,
      // the first swap is valued at $0 and the dashboard renders "?"
      // symbols until some later asset-bearing event arrives. With the
      // BiPoolExchange row already seeded by `BiPoolManager.ExchangeCreated`,
      // `selfHealWrappedExchangeId` mirrors `asset0/asset1` onto the Pool
      // and fetches their decimals via `tokenDecimalsScalingEffect`.
      //
      // Asset0 = USDC-like (6 decimals) to exercise the non-default path —
      // a stale 18 default would mis-scale `volumeUsdWei` for the very
      // first VP swap.
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      mockVpTokenDecimalsScaling();

      let mockDb = MockDb.createMockDb();
      // Step 1: ExchangeCreated seeds BiPoolExchange (asset0, asset1, feedID)
      // but NO Pool yet — VP wasn't observed yet, so wrappedByPoolId stays
      // empty and the Pool side is created on Step 2.
      const create = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(0, 100, 1_700_000_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event: create,
        mockDb,
      });

      // Step 2: VirtualPool.Swap is the first VP-side event — Pool gets
      // created here without defaults.token0/token1, then selfHeal runs.
      const swap = VirtualPool.Swap.createMockEvent({
        sender: ASSET0,
        amount0In: 1_000_000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 990_000n,
        to: ASSET1,
        mockEventData: mockEventData(1, 200, 1_700_001_000, VP_ADDRESS),
      });
      mockDb = await VirtualPool.Swap.processEvent({ event: swap, mockDb });

      const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
      const pool = mockDb.entities.Pool.get(poolId) as
        | {
            token0?: string;
            token1?: string;
            token0Decimals: number;
            token1Decimals: number;
            wrappedExchangeId?: string;
            referenceRateFeedID: string;
          }
        | undefined;
      assert.ok(pool);
      assert.equal(pool!.wrappedExchangeId, EXCHANGE_ID.toLowerCase());
      // Backfilled from BiPoolExchange.asset0/asset1.
      assert.equal(pool!.token0, ASSET0);
      assert.equal(pool!.token1, ASSET1);
      // Backfilled from decimals0()/decimals1() via tokenDecimalsScalingEffect.
      // 6 dp on the USDC-like leg is the load-bearing assertion: a stale
      // 18 default would mis-scale `volumeUsdWei` by 1e12.
      assert.equal(pool!.token0Decimals, 6);
      assert.equal(pool!.token1Decimals, 18);
      // Side-effect of the same heal path: feedID also mirrors over.
      assert.equal(pool!.referenceRateFeedID, FEED_ID);
    });

    it("reverse-link backfill: ExchangeCreated AFTER VP heals fills tokens+decimals via mirrorTokensAndDecimalsToPool", async function () {
      // Codex P2 round 2 #3: the heal-before-exchange ordering. VP self-
      // heals first (via VirtualPool.Swap → `selfHealWrappedExchangeId`)
      // when no `BiPoolExchange` row exists yet, so the heal path can't
      // mirror tokens / decimals. The reverse-link site in
      // `BiPoolManager.ExchangeCreated.handler` must mirror them when it
      // discovers the existing wrapping Pool via the `wrappedByPoolId`
      // back-link lookup. Without `mirrorTokensAndDecimalsToPool` the
      // Pool stays at `?/?` + 18/18 default forever.
      //
      // Round 3 #5 changed the heal path to also RPC-seed the
      // BiPoolExchange row inline. To exercise the reverse-link branch
      // specifically, we mock `poolExchangeEffect` to return null
      // (transient RPC failure) so the inline seed bails — leaving the
      // Pool healed-but-token-empty until ExchangeCreated lands.
      _setMockPoolExchange(CHAIN_ID, BIPOOL_MANAGER_ADDRESS, EXCHANGE_ID, null);
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      mockVpTokenDecimalsScaling();

      let mockDb = MockDb.createMockDb();
      // Step 1: VirtualPool.Swap heals wrappedExchangeId, but NO
      // BiPoolExchange exists yet, so token/decimal backfill is skipped
      // inside the heal helper.
      const swap = VirtualPool.Swap.createMockEvent({
        sender: ASSET0,
        amount0In: 1_000_000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 990_000n,
        to: ASSET1,
        mockEventData: mockEventData(0, 100, 1_700_000_000, VP_ADDRESS),
      });
      mockDb = await VirtualPool.Swap.processEvent({ event: swap, mockDb });

      const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
      const poolAfterHeal = mockDb.entities.Pool.get(poolId) as
        | {
            token0?: string;
            token1?: string;
            token0Decimals: number;
            wrappedExchangeId?: string;
          }
        | undefined;
      assert.ok(poolAfterHeal);
      assert.equal(poolAfterHeal!.wrappedExchangeId, EXCHANGE_ID.toLowerCase());
      // Heal couldn't backfill tokens — no BiPoolExchange row to mirror from.
      assert.equal(poolAfterHeal!.token0, undefined);
      assert.equal(poolAfterHeal!.token1, undefined);

      // Step 2: ExchangeCreated finally fires. Reverse-link discovers the
      // wrapping Pool via `Pool.getWhere.wrappedExchangeId.eq` and calls
      // `mirrorTokensAndDecimalsToPool` to fill the gaps.
      const create = BiPoolManager.ExchangeCreated.createMockEvent({
        exchangeId: EXCHANGE_ID,
        asset0: ASSET0,
        asset1: ASSET1,
        pricingModule: CONSTANT_SUM_MAINNET,
        mockEventData: mockEventData(1, 200, 1_700_001_000),
      });
      mockDb = await BiPoolManager.ExchangeCreated.processEvent({
        event: create,
        mockDb,
      });

      const poolFinal = mockDb.entities.Pool.get(poolId) as
        | {
            token0?: string;
            token1?: string;
            token0Decimals: number;
            token1Decimals: number;
          }
        | undefined;
      assert.ok(poolFinal);
      assert.equal(poolFinal!.token0, ASSET0);
      assert.equal(poolFinal!.token1, ASSET1);
      assert.equal(poolFinal!.token0Decimals, 6);
      assert.equal(poolFinal!.token1Decimals, 18);
    });

    it("heal-path inline seed: VirtualPool.Swap-first RPC-seeds BiPoolExchange so the swap valuation has correct decimals", async function () {
      // Codex P2 round 3 #5: when VP.Swap is the first observed event AND
      // the BiPoolExchange row doesn't exist yet, `selfHealWrappedExchangeId`
      // must RPC-seed the row (via `poolExchangeEffect`) before
      // `buildSwapTraderFields` consumes the pool. Without this, the
      // first SwapEvent.volumeUsdWei is mis-scaled at 18/18 decimals
      // and historical leaderboard rows lock the wrong values forever
      // (the later reverse-link backfill only touches Pool, not
      // SwapEvent).
      //
      // Setup: pool-exchange struct returns a 6dp asset0 (USDC-like).
      // The heal helper inline-seeds BiPoolExchange from the struct,
      // backfills tokens + decimals on the Pool, returns the healed
      // pool, and `buildSwapTraderFields` then uses the correct 6dp.
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      mockVpTokenDecimalsScaling();

      let mockDb = MockDb.createMockDb();
      // VirtualPool.Swap is the FIRST event — no prior BiPoolManager
      // event. Heal must RPC-seed the exchange row inline.
      const swap = VirtualPool.Swap.createMockEvent({
        sender: ASSET0,
        amount0In: 1_000_000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 990_000n,
        to: ASSET1,
        mockEventData: mockEventData(0, 100, 1_700_000_000, VP_ADDRESS),
      });
      mockDb = await VirtualPool.Swap.processEvent({ event: swap, mockDb });

      const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
      const pool = mockDb.entities.Pool.get(poolId) as
        | {
            token0?: string;
            token1?: string;
            token0Decimals: number;
            token1Decimals: number;
            wrappedExchangeId?: string;
            referenceRateFeedID: string;
          }
        | undefined;
      assert.ok(pool);
      assert.equal(pool!.wrappedExchangeId, EXCHANGE_ID.toLowerCase());
      // Tokens + decimals filled inline via the heal path's RPC seed.
      assert.equal(pool!.token0, ASSET0);
      assert.equal(pool!.token1, ASSET1);
      assert.equal(pool!.token0Decimals, 6);
      assert.equal(pool!.token1Decimals, 18);
      assert.equal(pool!.referenceRateFeedID, FEED_ID);

      // BiPoolExchange row was inline-seeded with wrappedByPoolId already set.
      const exchange = mockDb.entities.BiPoolExchange.get(
        exchangeRowId(EXCHANGE_ID),
      ) as
        | {
            wrappedByPoolId?: string;
            wrappedByPoolIdChecked: boolean;
            asset0: string;
          }
        | undefined;
      assert.ok(exchange);
      assert.equal(exchange!.wrappedByPoolId, poolId);
      assert.equal(exchange!.wrappedByPoolIdChecked, true);
      assert.equal(exchange!.asset0, ASSET0);
    });

    it("paired pinning: decimals fetch failure leaves both token AND decimals unset (gate-keeps-retry)", async function () {
      // Codex P2 round 4 #1: pinning the token address while leaving
      // decimals at the default 18 would lock in mis-scaled valuations
      // for any non-18dp leg. Fix: token + decimals are pinned as a
      // unit. If `tokenDecimalsScalingEffect` returns undefined, leave
      // both unset so the fully-healed gate (`pool.token0 &&
      // pool.token1`) keeps re-running the heal until decimals
      // succeed. Asserting the decimals-failure half here covers the
      // important invariant: no half-pinned state. The retry-success
      // companion path is exercised by the inline-seed test above
      // (which has decimals mocked) — that proves the heal does land
      // when decimals are available.
      _setMockPoolExchange(
        CHAIN_ID,
        BIPOOL_MANAGER_ADDRESS,
        EXCHANGE_ID,
        fullStruct(),
      );
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      // Simulate transient decimals RPC failures without touching live RPC.
      _setMockTokenDecimalsScaling(CHAIN_ID, VP_ADDRESS, "decimals0", null);
      _setMockTokenDecimalsScaling(CHAIN_ID, VP_ADDRESS, "decimals1", null);
      _setRpcClientForTests(CHAIN_ID, {
        readContract: async () => {
          throw new Error("mock RPC failure");
        },
      });

      let mockDb = MockDb.createMockDb();
      const swap = VirtualPool.Swap.createMockEvent({
        sender: ASSET0,
        amount0In: 1_000_000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 990_000n,
        to: ASSET1,
        mockEventData: mockEventData(0, 100, 1_700_000_000, VP_ADDRESS),
      });
      try {
        mockDb = await VirtualPool.Swap.processEvent({
          event: swap,
          mockDb,
        });
      } finally {
        _setRpcClientForTests(CHAIN_ID, null);
      }

      const poolId = makePoolId(CHAIN_ID, VP_ADDRESS);
      const poolAfterFailure = mockDb.entities.Pool.get(poolId) as
        | {
            token0?: string;
            token1?: string;
            wrappedExchangeId?: string;
          }
        | undefined;
      assert.ok(poolAfterFailure);
      // wrappedExchangeId pinned (bytecode is authoritative — dashboard's
      // isVirtualPool needs this to suppress FPMM panels even before
      // tokens land).
      assert.equal(
        poolAfterFailure!.wrappedExchangeId,
        EXCHANGE_ID.toLowerCase(),
      );
      // Tokens NOT pinned because decimals fetch failed. The
      // fully-healed gate (`wrappedExchangeId && token0 && token1`)
      // stays open, so the next event will re-attempt the heal.
      assert.equal(poolAfterFailure!.token0, undefined);
      assert.equal(poolAfterFailure!.token1, undefined);
    });
  });
});

describe("fetchTokenDecimalsScaling test mock", () => {
  beforeEach(() => {
    _clearMockTokenDecimalsScaling();
  });

  it("returns mocked decimals0()/decimals1() scaling before real RPC", async () => {
    const unsupportedChainId = 999_999;
    const upperPool = VP_ADDRESS.toUpperCase();

    _setMockTokenDecimalsScaling(
      unsupportedChainId,
      upperPool,
      "decimals0",
      1_000_000n,
    );
    _setMockTokenDecimalsScaling(
      unsupportedChainId,
      upperPool,
      "decimals1",
      1_000_000_000_000_000_000n,
    );

    assert.equal(
      await fetchTokenDecimalsScaling(
        unsupportedChainId,
        VP_ADDRESS,
        "decimals0",
        noopLogger,
      ),
      1_000_000n,
    );
    assert.equal(
      await fetchTokenDecimalsScaling(
        unsupportedChainId,
        VP_ADDRESS,
        "decimals1",
        noopLogger,
      ),
      1_000_000_000_000_000_000n,
    );
  });

  it("clears mocked decimals scaling and falls back to the RPC path", async () => {
    const unsupportedChainId = 999_999;

    _setMockTokenDecimalsScaling(
      unsupportedChainId,
      VP_ADDRESS,
      "decimals0",
      1_000_000n,
    );
    _clearMockTokenDecimalsScaling();

    assert.equal(
      await fetchTokenDecimalsScaling(
        unsupportedChainId,
        VP_ADDRESS,
        "decimals0",
        noopLogger,
      ),
      null,
    );
  });

  it("rejects a zero scaling factor as out-of-range", async () => {
    const unsupportedChainId = 999_999;
    _setMockTokenDecimalsScaling(
      unsupportedChainId,
      VP_ADDRESS,
      "decimals0",
      0n,
    );
    assert.equal(
      await fetchTokenDecimalsScaling(
        unsupportedChainId,
        VP_ADDRESS,
        "decimals0",
        noopLogger,
      ),
      null,
    );
  });

  it("rejects a scaling factor above 10^36 as out-of-range", async () => {
    const unsupportedChainId = 999_999;
    _setMockTokenDecimalsScaling(
      unsupportedChainId,
      VP_ADDRESS,
      "decimals0",
      10n ** 36n + 1n,
    );
    assert.equal(
      await fetchTokenDecimalsScaling(
        unsupportedChainId,
        VP_ADDRESS,
        "decimals0",
        noopLogger,
      ),
      null,
    );
  });
});

describe("fetchVirtualPoolExchangeId discriminator", () => {
  // Three-way return contract — preserved by `vpExchangeIdEffect` to decide
  // what's safe to cache:
  //   - VirtualPoolExchangeId  → VP, cache forever
  //   - null                   → bytecode present but pattern miss, cache forever
  //   - VP_PROBE_RPC_ERROR     → RPC threw, do NOT cache (transient)
  beforeEach(() => {
    _clearMockVpExchangeIds();
  });

  it("passes through a VirtualPoolExchangeId mock unchanged", async () => {
    _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
      exchangeProvider: BIPOOL_MANAGER_ADDRESS,
      exchangeId: EXCHANGE_ID,
    });
    const result = await fetchVirtualPoolExchangeId(CHAIN_ID, VP_ADDRESS);
    assert.deepEqual(result, {
      exchangeProvider: BIPOOL_MANAGER_ADDRESS,
      exchangeId: EXCHANGE_ID,
    });
  });

  it("returns null (permanent miss) when mock is null — caller treats this as cacheable not-VP", async () => {
    _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, null);
    const result = await fetchVirtualPoolExchangeId(CHAIN_ID, VP_ADDRESS);
    assert.equal(result, null);
  });

  it("returns VP_PROBE_RPC_ERROR (transient) when mock is the RPC-error sentinel", async () => {
    _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, VP_PROBE_RPC_ERROR);
    const result = await fetchVirtualPoolExchangeId(CHAIN_ID, VP_ADDRESS);
    assert.equal(result, VP_PROBE_RPC_ERROR);
  });
});

describe("isVirtualPool predicate", () => {
  // Two positive signals — either is sufficient. Healed VPs retain their
  // `fpmm_*` source by design (pickPreferredSource priority alignment), so
  // the wrappedExchangeId-based recognition is what classifies them
  // correctly downstream after PR #369.
  it("recognizes the canonical virtual_pool_factory source", () => {
    assert.equal(isVirtualPool({ source: "virtual_pool_factory" }), true);
  });

  it("recognizes any source containing 'virtual'", () => {
    assert.equal(isVirtualPool({ source: "virtual_swap" }), true);
  });

  it("recognizes a healed VP whose source is fpmm_* but wrappedExchangeId is set", () => {
    assert.equal(
      isVirtualPool({
        source: "fpmm_swap",
        wrappedExchangeId: "0xabc",
      }),
      true,
    );
  });

  it("classifies a plain FPMM (fpmm_* source, no wrappedExchangeId) as non-virtual", () => {
    assert.equal(isVirtualPool({ source: "fpmm_swap" }), false);
    assert.equal(
      isVirtualPool({ source: "fpmm_swap", wrappedExchangeId: undefined }),
      false,
    );
    assert.equal(
      isVirtualPool({ source: "fpmm_swap", wrappedExchangeId: "" }),
      false,
    );
  });
});

describe("extractVpExchangeIdFromBytecode", () => {
  // Real VirtualPool bytecode pattern: PUSH32 mgrAddr (right-aligned in 32B),
  // [DUP2 AND PUSH1 0x04 DUP4 ADD MSTORE], PUSH32 exchangeId.
  function buildVpBytecode(mgrAddr: string, exchangeId: string): string {
    const mgrPaddedHex = mgrAddr
      .toLowerCase()
      .replace(/^0x/, "")
      .padStart(64, "0");
    const exchangeIdHex = exchangeId.toLowerCase().replace(/^0x/, "");
    // 7f<32B mgr> 81 16 6004 83 01 52 7f<32B exchangeId>
    return `0x6080${"00".repeat(20)}7f${mgrPaddedHex}811660048301527f${exchangeIdHex}5b50`;
  }

  it("extracts exchangeProvider (bottom 20B) + exchangeId from synthetic VP bytecode", () => {
    const bytecode = buildVpBytecode(BIPOOL_MANAGER_ADDRESS, EXCHANGE_ID);
    const extracted = extractVpExchangeIdFromBytecode(bytecode);
    assert.ok(extracted, "should match");
    assert.equal(extracted!.exchangeProvider, BIPOOL_MANAGER_ADDRESS);
    assert.equal(extracted!.exchangeId, EXCHANGE_ID.toLowerCase());
  });

  it("returns null on bytecode without the pattern", () => {
    const noisy =
      "0x6080604052348015600f57600080fd5b50602b8060186000396000f3fe";
    assert.equal(extractVpExchangeIdFromBytecode(noisy), null);
  });

  it("lowercases the output even when input contains uppercase hex", () => {
    const bytecode = buildVpBytecode(
      BIPOOL_MANAGER_ADDRESS.toUpperCase(),
      EXCHANGE_ID.toUpperCase(),
    );
    const extracted = extractVpExchangeIdFromBytecode(bytecode);
    assert.ok(extracted);
    assert.equal(extracted!.exchangeProvider, BIPOOL_MANAGER_ADDRESS);
    assert.equal(extracted!.exchangeId, EXCHANGE_ID.toLowerCase());
  });
});
