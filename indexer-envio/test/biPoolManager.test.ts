/// <reference types="mocha" />
import assert from "node:assert/strict";
import generated from "generated";
import {
  _setMockPoolExchange,
  _clearMockPoolExchanges,
  _setMockVpExchangeId,
  _clearMockVpExchangeIds,
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
} from "../src/EventHandlers.ts";
import {
  extractVpExchangeIdFromBytecode,
  type PoolExchangeStruct,
} from "../src/rpc/biPoolManager.ts";
import { _clearPricingModuleIndex } from "../src/contractAddresses.ts";
import { makePoolId } from "../src/helpers.ts";

type MockDb = {
  entities: {
    Pool: { get: (id: string) => unknown; set: (e: unknown) => MockDb };
    BiPoolExchange: {
      get: (id: string) => unknown;
      set: (e: unknown) => MockDb;
    };
    BucketUpdate: { get: (id: string) => unknown };
    [key: string]: { get: (id: string) => unknown };
  };
};

type EventProcessor<E> = {
  createMockEvent: (args: E) => unknown;
  processEvent: (args: { event: unknown; mockDb: MockDb }) => Promise<MockDb>;
};

type MockEventData = {
  chainId: number;
  logIndex: number;
  srcAddress: string;
  block: { number: number; timestamp: number };
};

type ExchangeCreatedArgs = {
  exchangeId: string;
  asset0: string;
  asset1: string;
  pricingModule: string;
  mockEventData: MockEventData;
};

type ExchangeDestroyedArgs = {
  exchangeId: string;
  asset0: string;
  asset1: string;
  pricingModule: string;
  mockEventData: MockEventData;
};

type BucketsUpdatedArgs = {
  exchangeId: string;
  bucket0: bigint;
  bucket1: bigint;
  mockEventData: MockEventData;
};

type SpreadUpdatedArgs = {
  exchangeId: string;
  spread: bigint;
  mockEventData: MockEventData;
};

type VPDeployedArgs = {
  pool: string;
  token0: string;
  token1: string;
  mockEventData: MockEventData;
};

type VPSwapArgs = {
  sender: string;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  to: string;
  mockEventData: MockEventData;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    BiPoolManager: {
      ExchangeCreated: EventProcessor<ExchangeCreatedArgs>;
      ExchangeDestroyed: EventProcessor<ExchangeDestroyedArgs>;
      BucketsUpdated: EventProcessor<BucketsUpdatedArgs>;
      SpreadUpdated: EventProcessor<SpreadUpdatedArgs>;
    };
    VirtualPoolFactory: {
      VirtualPoolDeployed: EventProcessor<VPDeployedArgs>;
    };
    VirtualPool: {
      Swap: EventProcessor<VPSwapArgs>;
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
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

function exchangeRowId(exchangeId: string): string {
  return `${CHAIN_ID}-${exchangeId.toLowerCase()}`;
}

function mockEventData(
  logIndex: number,
  blockNumber: number,
  blockTs: number,
  srcAddress: string = BIPOOL_MANAGER_ADDRESS,
): MockEventData {
  return {
    chainId: CHAIN_ID,
    logIndex,
    srcAddress,
    block: { number: blockNumber, timestamp: blockTs },
  };
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

describe("BiPoolManager handlers", () => {
  beforeEach(() => {
    _clearMockPoolExchanges();
    _clearMockVpExchangeIds();
    _clearMockERC20Decimals();
    _clearPricingModuleIndex();
  });

  describe("ExchangeCreated", () => {
    it("populates BiPoolExchange from RPC backfill struct + resolves pricingModuleName", async function () {
      this.timeout(10_000);
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
    });

    it("falls through to event params + zero stubs when RPC backfill fails", async function () {
      this.timeout(10_000);
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
    });
  });

  describe("ExchangeDestroyed", () => {
    it("sets isDeprecated=true on existing row", async function () {
      this.timeout(10_000);
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
      this.timeout(10_000);
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
    });
  });

  describe("BucketsUpdated", () => {
    it("appends a BucketUpdate row + denormalizes onto BiPoolExchange", async function () {
      this.timeout(10_000);
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
  });

  describe("SpreadUpdated", () => {
    it("updates spread on the existing row", async function () {
      this.timeout(10_000);
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
      this.timeout(10_000);
      // Step 1: VP deploys first (rare but possible). Bytecode extractor mock
      // returns the exchangeId; struct backfill mock omitted because
      // BiPoolExchange doesn't exist yet — the VP handler should still
      // persist `Pool.wrappedExchangeId`.
      _setMockVpExchangeId(CHAIN_ID, VP_ADDRESS, {
        exchangeProvider: BIPOOL_MANAGER_ADDRESS,
        exchangeId: EXCHANGE_ID,
      });
      // ERC20 decimals fallback for the dec0/dec1 effects (no FPMM getter
      // on a VP, so the fallback fires; without mock it logs a warn).
      _setMockERC20Decimals(CHAIN_ID, ASSET0, 18);
      _setMockERC20Decimals(CHAIN_ID, ASSET1, 18);

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

    it("self-heals wrappedExchangeId when first event is VirtualPool.Swap (fpmm_* source override)", async function () {
      this.timeout(10_000);
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
