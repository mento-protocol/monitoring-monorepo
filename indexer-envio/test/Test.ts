/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";

type GeneratedModule = {
  TestHelpers: {
    MockDb: {
      createMockDb: () => {
        entities: {
          FactoryDeployment: { get: (id: string) => unknown };
          Pool: { get: (id: string) => unknown };
          SwapEvent: { get: (id: string) => unknown };
        };
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
        }) => {
          chainId: number;
          logIndex: number;
          block: { number: number; timestamp: number };
          params: {
            token0: string;
            token1: string;
            fpmmProxy: string;
            fpmmImplementation: string;
          };
        };
        processEvent: (args: {
          event: {
            chainId: number;
            logIndex: number;
            block: { number: number; timestamp: number };
          };
          mockDb: {
            entities: {
              FactoryDeployment: { get: (id: string) => unknown };
              Pool: { get: (id: string) => unknown };
              SwapEvent: { get: (id: string) => unknown };
            };
          };
        }) => Promise<{
          entities: {
            FactoryDeployment: { get: (id: string) => unknown };
            Pool: { get: (id: string) => unknown };
            SwapEvent: { get: (id: string) => unknown };
          };
        }>;
      };
    };
    FPMM: {
      Swap: {
        createMockEvent: (args: {
          sender: string;
          to: string;
          amount0In: bigint;
          amount1In: bigint;
          amount0Out: bigint;
          amount1Out: bigint;
          mockEventData: {
            chainId: number;
            logIndex: number;
            srcAddress: string;
            block: { number: number; timestamp: number };
          };
        }) => {
          chainId: number;
          logIndex: number;
          srcAddress: string;
          block: { number: number; timestamp: number };
          params: {
            sender: string;
            to: string;
            amount0In: bigint;
            amount1In: bigint;
            amount0Out: bigint;
            amount1Out: bigint;
          };
        };
        processEvent: (args: {
          event: {
            chainId: number;
            logIndex: number;
            block: { number: number; timestamp: number };
            srcAddress: string;
          };
          mockDb: {
            entities: {
              FactoryDeployment: { get: (id: string) => unknown };
              Pool: { get: (id: string) => unknown };
              SwapEvent: { get: (id: string) => unknown };
            };
          };
        }) => Promise<{
          entities: {
            FactoryDeployment: { get: (id: string) => unknown };
            Pool: { get: (id: string) => unknown };
            SwapEvent: { get: (id: string) => unknown };
          };
        }>;
      };
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

describe("Envio Celo indexer handlers", () => {
  it("persists FactoryDeployment + Pool for FPMMDeployed", async () => {
    const mockDb = MockDb.createMockDb();
    const event = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000001",
      token1: "0x0000000000000000000000000000000000000002",
      fpmmProxy: "0x00000000000000000000000000000000000000aa",
      fpmmImplementation: "0x00000000000000000000000000000000000000bb",
      mockEventData: {
        chainId: 42220,
        logIndex: 3,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 100, timestamp: 1_700_000_000 },
      },
    });
    const id = `${event.chainId}_${event.block.number}_${event.logIndex}`;

    const mockDbUpdated = await FPMMFactory.FPMMDeployed.processEvent({
      event,
      mockDb,
    });

    const deployment = mockDbUpdated.entities.FactoryDeployment.get(id) as
      | {
          poolId: string;
          token0: string;
          token1: string;
          implementation: string;
        }
      | undefined;
    assert.ok(deployment);
    if (!deployment) {
      throw new Error("Expected FactoryDeployment entity to be written");
    }
    assert.equal(
      deployment.poolId,
      "0x00000000000000000000000000000000000000aa",
    );
    assert.equal(
      deployment.implementation,
      "0x00000000000000000000000000000000000000bb",
    );

    const pool = mockDbUpdated.entities.Pool.get(
      "0x00000000000000000000000000000000000000aa",
    ) as { token0?: string; token1?: string; source: string } | undefined;
    assert.ok(pool);
    if (!pool) {
      throw new Error("Expected Pool entity to be written for FPMMDeployed");
    }
    assert.equal(pool.source, "fpmm_factory");
    assert.equal(pool.token0, "0x0000000000000000000000000000000000000001");
    assert.equal(pool.token1, "0x0000000000000000000000000000000000000002");
  });

  it("persists SwapEvent + upserts Pool for Swap", async () => {
    const mockDb = MockDb.createMockDb();
    const event = FPMM.Swap.createMockEvent({
      sender: "0x0000000000000000000000000000000000000011",
      to: "0x0000000000000000000000000000000000000022",
      amount0In: 5n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 7n,
      mockEventData: {
        chainId: 42220,
        logIndex: 9,
        srcAddress: "0x00000000000000000000000000000000000000dd",
        block: { number: 101, timestamp: 1_700_000_123 },
      },
    });
    const id = `${event.chainId}_${event.block.number}_${event.logIndex}`;

    const mockDbUpdated = await FPMM.Swap.processEvent({
      event,
      mockDb,
    });

    const swap = mockDbUpdated.entities.SwapEvent.get(id) as
      | { poolId: string; sender: string; recipient: string }
      | undefined;
    assert.ok(swap);
    if (!swap) {
      throw new Error("Expected SwapEvent entity to be written");
    }
    assert.equal(swap.poolId, "0x00000000000000000000000000000000000000dd");
    assert.equal(swap.sender, "0x0000000000000000000000000000000000000011");
    assert.equal(swap.recipient, "0x0000000000000000000000000000000000000022");

    const pool = mockDbUpdated.entities.Pool.get(
      "0x00000000000000000000000000000000000000dd",
    ) as { source: string; token0?: string; token1?: string } | undefined;
    assert.ok(pool);
    if (!pool) {
      throw new Error("Expected Pool entity to be upserted for Swap");
    }
    assert.equal(pool.source, "fpmm_swap");
    assert.equal(pool.token0, undefined);
    assert.equal(pool.token1, undefined);
  });
});
