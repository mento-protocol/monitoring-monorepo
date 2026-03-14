/// <reference types="mocha" />
import assert from "node:assert/strict";
import generated from "generated";

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
