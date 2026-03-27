/// <reference types="mocha" />
import assert from "node:assert/strict";
import generated from "generated";
import {
  _setMockFeeTokenMeta,
  _clearMockFeeTokenMeta,
  _clearBackfilledTokens,
  _clearFeeTokenMetaCache,
  selectStaleTransfers,
} from "../src/EventHandlers.ts";
import { makePoolId } from "../src/helpers.ts";

/** Shorthand: create a namespaced pool ID for chainId 42220 (used in all tests). */
const pid = (addr: string): string => makePoolId(42220, addr);

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

type MockDb = {
  entities: {
    Pool: { get: (id: string) => unknown; set: (e: unknown) => MockDb };
    ProtocolFeeTransfer: { get: (id: string) => unknown };
    [key: string]: { get: (id: string) => unknown };
  };
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    ERC20FeeToken: {
      Transfer: {
        createMockEvent: (args: {
          from?: string;
          to?: string;
          value?: bigint;
          mockEventData?: {
            chainId?: number;
            srcAddress?: string;
            logIndex?: number;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
    };
    FPMMFactory: {
      FPMMDeployed: {
        createMockEvent: (args: {
          token0: string;
          token1: string;
          fpmmProxy: string;
          fpmmImplementation: string;
          mockEventData: {
            chainId: number;
            logIndex: number;
            srcAddress: string;
            block: { number: number; timestamp: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, ERC20FeeToken, FPMMFactory } = TestHelpers;

/** The yield-split address used as `to` in production. */
const YIELD_SPLIT = "0x0dd57f6f181d0469143fe9380762d8a112e96e4a" as const;

/** A known FPMM pool address (will be seeded in the mock DB). */
const POOL_ADDRESS = "0x00000000000000000000000000000000000000aa";

/** An arbitrary external address (NOT a known pool). */
const RANDOM_SENDER = "0x0000000000000000000000000000000000dead01";

/** A token address representing the ERC20 being transferred. */
const TOKEN_ADDRESS = "0x0000000000000000000000000000000000000042";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a minimal FPMM pool so context.Pool.get(POOL_ADDRESS) returns a pool
 * with `source` containing "fpmm".
 */
async function seedFpmmPool(mockDb: MockDb): Promise<MockDb> {
  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: TOKEN_ADDRESS,
    token1: "0x0000000000000000000000000000000000000043",
    fpmmProxy: POOL_ADDRESS,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId: 42220,
      logIndex: 1,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: 100, timestamp: 1_700_000_000 },
    },
  });
  return FPMMFactory.FPMMDeployed.processEvent({ event: deployEvent, mockDb });
}

function createTransferEvent(overrides: {
  from?: string;
  to?: string;
  value?: bigint;
  srcAddress?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  logIndex?: number;
}) {
  return ERC20FeeToken.Transfer.createMockEvent({
    from: overrides.from ?? POOL_ADDRESS,
    to: overrides.to ?? YIELD_SPLIT,
    value: overrides.value ?? BigInt("1000000000000000000"), // 1e18
    mockEventData: {
      chainId: 42220,
      srcAddress: overrides.srcAddress ?? TOKEN_ADDRESS,
      logIndex: overrides.logIndex ?? 10,
      block: {
        number: overrides.blockNumber ?? 500,
        timestamp: overrides.blockTimestamp ?? 1_700_100_000,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ERC20FeeToken.Transfer handler", () => {
  it("persists a ProtocolFeeTransfer when sender is a known FPMM pool", async function () {
    this.timeout(10_000);
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);

    const event = createTransferEvent({ from: POOL_ADDRESS });
    const updatedDb = await ERC20FeeToken.Transfer.processEvent({
      event,
      mockDb,
    });

    const id = `42220_500_10`; // chainId_blockNumber_logIndex
    const transfer = updatedDb.entities.ProtocolFeeTransfer.get(id) as
      | { from: string; amount: bigint; token: string }
      | undefined;
    assert.ok(transfer, "Expected ProtocolFeeTransfer entity to be written");
    assert.equal(transfer!.from, POOL_ADDRESS);
    assert.equal(transfer!.token, TOKEN_ADDRESS);
  });

  it("skips transfers from non-pool senders", async function () {
    this.timeout(10_000);
    let mockDb = MockDb.createMockDb();
    // Seed the FPMM pool so the handler has a real DB, but send from a
    // different address that is NOT a pool.
    mockDb = await seedFpmmPool(mockDb);

    const event = createTransferEvent({ from: RANDOM_SENDER, logIndex: 20 });
    const updatedDb = await ERC20FeeToken.Transfer.processEvent({
      event,
      mockDb,
    });

    const id = `42220_500_20`;
    const transfer = updatedDb.entities.ProtocolFeeTransfer.get(id);
    assert.equal(
      transfer,
      undefined,
      "ProtocolFeeTransfer should NOT be written for non-pool senders",
    );
  });

  it("skips transfers when no pool exists at all", async function () {
    this.timeout(10_000);
    const mockDb = MockDb.createMockDb();
    // No pools seeded — completely empty DB.

    const event = createTransferEvent({ from: RANDOM_SENDER, logIndex: 30 });
    const updatedDb = await ERC20FeeToken.Transfer.processEvent({
      event,
      mockDb,
    });

    const id = `42220_500_30`;
    const transfer = updatedDb.entities.ProtocolFeeTransfer.get(id);
    assert.equal(
      transfer,
      undefined,
      "ProtocolFeeTransfer should NOT be written when no pools exist",
    );
  });
});

describe("UNKNOWN backfill behavior", () => {
  const TOKEN_2 = "0x0000000000000000000000000000000000000099";
  const CHAIN_A = 42220;

  afterEach(() => {
    _clearMockFeeTokenMeta();
    _clearBackfilledTokens();
    _clearFeeTokenMetaCache(); // prevent cross-test cache pollution
  });

  it("stores UNKNOWN when RPC fails on first transfer", async function () {
    this.timeout(15_000);
    _setMockFeeTokenMeta(CHAIN_A, TOKEN_2, "FAIL");
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);
    const event = createTransferEvent({
      srcAddress: TOKEN_2,
      logIndex: 40,
      blockNumber: 600,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event, mockDb });
    const id = `${CHAIN_A}_600_40`;
    const transfer = mockDb.entities.ProtocolFeeTransfer.get(id) as
      | { tokenSymbol: string }
      | undefined;
    assert.equal(
      transfer?.tokenSymbol,
      "UNKNOWN",
      "RPC failure should store UNKNOWN placeholder",
    );
  });

  it("stores resolved symbol when RPC succeeds", async function () {
    this.timeout(15_000);
    _setMockFeeTokenMeta(CHAIN_A, TOKEN_2, { symbol: "GBPm", decimals: 18 });
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);
    const event = createTransferEvent({
      srcAddress: TOKEN_2,
      logIndex: 41,
      blockNumber: 601,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({ event, mockDb });
    const id = `${CHAIN_A}_601_41`;
    const transfer = mockDb.entities.ProtocolFeeTransfer.get(id) as
      | { tokenSymbol: string }
      | undefined;
    assert.equal(
      transfer?.tokenSymbol,
      "GBPm",
      "Successful RPC should store the resolved symbol",
    );
  });

  it("retries resolution on subsequent transfer after RPC failure (no permanent skip)", async function () {
    this.timeout(15_000);
    // First transfer: fails
    _setMockFeeTokenMeta(CHAIN_A, TOKEN_2, "FAIL");
    let mockDb = MockDb.createMockDb();
    mockDb = await seedFpmmPool(mockDb);
    const event1 = createTransferEvent({
      srcAddress: TOKEN_2,
      logIndex: 50,
      blockNumber: 700,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({
      event: event1,
      mockDb,
    });
    const id1 = `${CHAIN_A}_700_50`;
    const stale = mockDb.entities.ProtocolFeeTransfer.get(id1) as
      | { tokenSymbol: string }
      | undefined;
    assert.equal(stale?.tokenSymbol, "UNKNOWN");

    // Second transfer: RPC now succeeds — feeTokenMetaCache should NOT have a
    // cached failure (failures are not cached), so this should resolve correctly.
    _clearMockFeeTokenMeta();
    _setMockFeeTokenMeta(CHAIN_A, TOKEN_2, { symbol: "GBPm", decimals: 18 });
    const event2 = createTransferEvent({
      srcAddress: TOKEN_2,
      logIndex: 51,
      blockNumber: 701,
    });
    mockDb = await ERC20FeeToken.Transfer.processEvent({
      event: event2,
      mockDb,
    });
    const id2 = `${CHAIN_A}_701_51`;
    const resolved = mockDb.entities.ProtocolFeeTransfer.get(id2) as
      | { tokenSymbol: string }
      | undefined;
    assert.equal(
      resolved?.tokenSymbol,
      "GBPm",
      "Retry after RPC failure should successfully resolve the symbol — failures must not be cached",
    );
  });
});

// ---------------------------------------------------------------------------
// selectStaleTransfers — pure backfill filter (no DB required)
// Tests the core correctness rules of the backfill path:
//   1. Only UNKNOWN records are selected
//   2. Only records from the same chain are selected (cross-chain safety)
//   3. Already-resolved records are skipped
// ---------------------------------------------------------------------------

describe("selectStaleTransfers", () => {
  const CHAIN_A = 42220;
  const CHAIN_B = 143;
  const TOKEN = "0x0000000000000000000000000000000000000042";

  it("returns only UNKNOWN records for the given chainId", () => {
    const records = [
      { id: `${CHAIN_A}_100_1`, tokenSymbol: "UNKNOWN" },
      { id: `${CHAIN_A}_101_2`, tokenSymbol: "GBPm" }, // already resolved
      { id: `${CHAIN_A}_102_3`, tokenSymbol: "UNKNOWN" },
    ];
    const stale = selectStaleTransfers(records, CHAIN_A);
    assert.deepEqual(
      stale.map((r) => r.id),
      [`${CHAIN_A}_100_1`, `${CHAIN_A}_102_3`],
    );
  });

  it("does NOT select UNKNOWN records from a different chain", () => {
    const records = [
      { id: `${CHAIN_A}_200_1`, tokenSymbol: "UNKNOWN" }, // chain A
      { id: `${CHAIN_B}_200_1`, tokenSymbol: "UNKNOWN" }, // chain B — same token, different chain
    ];
    const stale = selectStaleTransfers(records, CHAIN_A);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.id, `${CHAIN_A}_200_1`);
  });

  it("returns empty array when all records are already resolved", () => {
    const records = [
      { id: `${CHAIN_A}_300_1`, tokenSymbol: "USDm" },
      { id: `${CHAIN_A}_300_2`, tokenSymbol: "GBPm" },
    ];
    assert.deepEqual(selectStaleTransfers(records, CHAIN_A), []);
  });

  it("returns empty array when records list is empty", () => {
    assert.deepEqual(selectStaleTransfers([], CHAIN_A), []);
  });

  it("is not confused by a chainId that is a prefix of another (e.g. 42 vs 42220)", () => {
    const SHORT_CHAIN = 42; // shorter chainId
    const records = [
      { id: `${CHAIN_A}_400_1`, tokenSymbol: "UNKNOWN" }, // 42220_ — should NOT match chain 42
    ];
    const stale = selectStaleTransfers(records, SHORT_CHAIN);
    assert.equal(
      stale.length,
      0,
      "42220_ should not be matched by chainId=42 prefix check",
    );
  });
});
