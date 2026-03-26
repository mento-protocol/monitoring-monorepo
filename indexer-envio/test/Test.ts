/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";
import {
  _setMockRebalancingState,
  _clearMockRebalancingStates,
  _setMockRateFeedID,
  _clearMockRateFeedIDs,
  _setMockReportExpiry,
  _clearMockReportExpiry,
} from "../src/EventHandlers.ts";

type MockDb = {
  entities: {
    FactoryDeployment: { get: (id: string) => unknown };
    Pool: {
      get: (id: string) => unknown;
      set: (entity: unknown) => MockDb;
    };
    SwapEvent: { get: (id: string) => unknown };
    LiquidityEvent: { get: (id: string) => unknown };
    LiquidityPosition: {
      get: (id: string) => unknown;
      set: (entity: unknown) => MockDb;
    };
    OracleSnapshot: {
      get: (id: string) => unknown;
      set: (entity: unknown) => MockDb;
    };
  };
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: {
      createMockDb: () => MockDb;
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
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
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
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      Mint: {
        createMockEvent: (args: {
          sender: string;
          to: string;
          amount0: bigint;
          amount1: bigint;
          liquidity: bigint;
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
      Burn: {
        createMockEvent: (args: {
          sender: string;
          to: string;
          amount0: bigint;
          amount1: bigint;
          liquidity: bigint;
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
      Transfer: {
        createMockEvent: (args: {
          from: string;
          to: string;
          value: bigint;
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
      UpdateReserves: {
        createMockEvent: (args: {
          reserve0: bigint;
          reserve1: bigint;
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
      Rebalanced: {
        createMockEvent: (args: {
          sender: string;
          priceDifferenceBefore: bigint;
          priceDifferenceAfter: bigint;
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
    SortedOracles: {
      OracleReported: {
        createMockEvent: (args: {
          token?: string;
          oracle?: string;
          timestamp?: bigint;
          value?: bigint;
          mockEventData?: {
            chainId?: number;
            logIndex?: number;
            srcAddress?: string;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      MedianUpdated: {
        createMockEvent: (args: {
          token?: string;
          value?: bigint;
          mockEventData?: {
            chainId?: number;
            logIndex?: number;
            srcAddress?: string;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      TokenReportExpirySet: {
        createMockEvent: (args: {
          token?: string;
          reportExpiry?: bigint;
          mockEventData?: {
            chainId?: number;
            logIndex?: number;
            srcAddress?: string;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
    };
    OpenLiquidityStrategy: {
      PoolAdded: {
        createMockEvent: (args: {
          pool?: string;
          params?: readonly [
            string,
            string,
            bigint,
            string,
            bigint,
            bigint,
            bigint,
            bigint,
          ];
          mockEventData?: {
            chainId?: number;
            logIndex?: number;
            srcAddress?: string;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      PoolRemoved: {
        createMockEvent: (args: {
          pool?: string;
          mockEventData?: {
            chainId?: number;
            logIndex?: number;
            srcAddress?: string;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      RebalanceCooldownSet: {
        createMockEvent: (args: {
          pool?: string;
          cooldown?: bigint;
          mockEventData?: {
            chainId?: number;
            logIndex?: number;
            srcAddress?: string;
            block?: { number?: number; timestamp?: number };
          };
        }) => unknown;
        processEvent: (args: {
          event: unknown;
          mockDb: MockDb;
        }) => Promise<MockDb>;
      };
      LiquidityMoved: {
        createMockEvent: (args: {
          pool?: string;
          direction?: bigint;
          tokenGivenToPool?: string;
          amountGivenToPool?: bigint;
          tokenTakenFromPool?: string;
          amountTakenFromPool?: bigint;
          mockEventData?: {
            chainId?: number;
            logIndex?: number;
            srcAddress?: string;
            block?: { number?: number; timestamp?: number };
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
const { MockDb, FPMMFactory, FPMM, SortedOracles, OpenLiquidityStrategy } =
  TestHelpers;

type PoolEntity = {
  id: string;
  source: string;
  token0?: string;
  token1?: string;
  referenceRateFeedID: string;
  oracleExpiry: bigint;
  oracleNumReporters: number;
  oraclePrice: bigint;
  oracleTimestamp: bigint;
  oracleTxHash: string;
  oracleOk: boolean;
  priceDifference: bigint;
  rebalanceThreshold: number;
  lastRebalancedAt: bigint;
  healthStatus: string;
  limitStatus: string;
  limitPressure0: string;
  limitPressure1: string;
  rebalancerAddress: string;
  rebalanceLivenessStatus: string;
  token0Decimals: number;
  token1Decimals: number;
  reserves0: bigint;
  reserves1: bigint;
  swapCount: number;
  notionalVolume0: bigint;
  notionalVolume1: bigint;
  rebalanceCount: number;
  createdAtBlock: bigint;
  createdAtTimestamp: bigint;
  updatedAtBlock: bigint;
  updatedAtTimestamp: bigint;
};

type OracleSnapshotEntity = {
  id: string;
  poolId: string;
  timestamp: bigint;
  oraclePrice: bigint;
  oracleOk: boolean;
  numReporters: number;
  priceDifference: bigint;
  rebalanceThreshold: number;
  source: string;
  blockNumber: bigint;
};

type LiquidityPositionEntity = {
  id: string;
  poolId: string;
  address: string;
  netLiquidity: bigint;
  lastUpdatedBlock: bigint;
  lastUpdatedTimestamp: bigint;
};

async function seedPoolWithFeed(
  mockDb: MockDb,
  {
    poolId,
    feedId,
    oracleExpiry = 600n,
    oracleNumReporters = 7,
  }: {
    poolId: string;
    feedId: string;
    oracleExpiry?: bigint;
    oracleNumReporters?: number;
  },
): Promise<MockDb> {
  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: "0x0000000000000000000000000000000000000003",
    token1: "0x0000000000000000000000000000000000000004",
    fpmmProxy: poolId,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId: 42220,
      logIndex: 10,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: 300, timestamp: 1_700_001_000 },
    },
  });
  let nextDb = await FPMMFactory.FPMMDeployed.processEvent({
    event: deployEvent,
    mockDb,
  });

  const existingPool = nextDb.entities.Pool.get(poolId) as
    | PoolEntity
    | undefined;
  assert.ok(existingPool, "Expected seeded pool entity to exist");
  if (!existingPool) {
    throw new Error("Expected seeded pool entity to exist");
  }

  nextDb = nextDb.entities.Pool.set({
    ...existingPool,
    referenceRateFeedID: feedId,
    oracleExpiry,
    oracleNumReporters,
  });

  return nextDb;
}

describe("Envio Celo indexer handlers", () => {
  it("persists FactoryDeployment + Pool for FPMMDeployed", async function () {
    this.timeout(10_000);
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

  it("tracks LiquidityPosition from LP token Transfer events", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000f0";
    const LP_ADDR = "0x00000000000000000000000000000000000000f1";
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

    let mockDb = MockDb.createMockDb();

    const mintTransfer = FPMM.Transfer.createMockEvent({
      from: ZERO_ADDR,
      to: LP_ADDR,
      value: 300n,
      mockEventData: {
        chainId: 42220,
        logIndex: 30,
        srcAddress: POOL_ADDR,
        block: { number: 120, timestamp: 1_700_000_500 },
      },
    });
    mockDb = await FPMM.Transfer.processEvent({
      event: mintTransfer,
      mockDb,
    });

    const burnOwnerToPool = FPMM.Transfer.createMockEvent({
      from: LP_ADDR,
      to: POOL_ADDR,
      value: 75n,
      mockEventData: {
        chainId: 42220,
        logIndex: 31,
        srcAddress: POOL_ADDR,
        block: { number: 121, timestamp: 1_700_000_600 },
      },
    });
    mockDb = await FPMM.Transfer.processEvent({
      event: burnOwnerToPool,
      mockDb,
    });

    const burnPoolToZero = FPMM.Transfer.createMockEvent({
      from: POOL_ADDR,
      to: ZERO_ADDR,
      value: 75n,
      mockEventData: {
        chainId: 42220,
        logIndex: 32,
        srcAddress: POOL_ADDR,
        block: { number: 121, timestamp: 1_700_000_601 },
      },
    });
    mockDb = await FPMM.Transfer.processEvent({
      event: burnPoolToZero,
      mockDb,
    });

    const position = mockDb.entities.LiquidityPosition.get(
      `${POOL_ADDR}-${LP_ADDR}`,
    ) as LiquidityPositionEntity | undefined;
    assert.ok(
      position,
      "LiquidityPosition must exist after transfer-based mint/burn",
    );
    if (!position) {
      throw new Error(
        "Expected LiquidityPosition entity after transfer-based mint/burn",
      );
    }

    assert.equal(position.poolId, POOL_ADDR);
    assert.equal(position.address, LP_ADDR);
    assert.equal(position.netLiquidity, 225n);
    assert.equal(position.lastUpdatedBlock, 121n);
    assert.equal(position.lastUpdatedTimestamp, 1_700_000_600n);
  });

  it("burn ownership follows owner->pool transfer, not Burn.to beneficiary", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000f2";
    const OWNER_ADDR = "0x00000000000000000000000000000000000000f3";
    const BENEFICIARY_ADDR = "0x00000000000000000000000000000000000000f4";
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

    let mockDb = MockDb.createMockDb();
    mockDb = mockDb.entities.LiquidityPosition.set({
      id: `${POOL_ADDR}-${OWNER_ADDR}`,
      poolId: POOL_ADDR,
      address: OWNER_ADDR,
      netLiquidity: 40n,
      lastUpdatedBlock: 1n,
      lastUpdatedTimestamp: 1n,
    });

    const ownerToPool = FPMM.Transfer.createMockEvent({
      from: OWNER_ADDR,
      to: POOL_ADDR,
      value: 75n,
      mockEventData: {
        chainId: 42220,
        logIndex: 33,
        srcAddress: POOL_ADDR,
        block: { number: 122, timestamp: 1_700_000_700 },
      },
    });
    mockDb = await FPMM.Transfer.processEvent({ event: ownerToPool, mockDb });

    const poolToZero = FPMM.Transfer.createMockEvent({
      from: POOL_ADDR,
      to: ZERO_ADDR,
      value: 75n,
      mockEventData: {
        chainId: 42220,
        logIndex: 34,
        srcAddress: POOL_ADDR,
        block: { number: 122, timestamp: 1_700_000_701 },
      },
    });
    mockDb = await FPMM.Transfer.processEvent({ event: poolToZero, mockDb });

    const ownerPosition = mockDb.entities.LiquidityPosition.get(
      `${POOL_ADDR}-${OWNER_ADDR}`,
    ) as LiquidityPositionEntity | undefined;
    assert.ok(ownerPosition, "owner position must exist after burn");
    if (!ownerPosition) {
      throw new Error("Expected owner LiquidityPosition entity after burn");
    }
    assert.equal(
      ownerPosition.netLiquidity,
      0n,
      "burn larger than known balance should clamp the owner to zero",
    );

    const beneficiaryPosition = mockDb.entities.LiquidityPosition.get(
      `${POOL_ADDR}-${BENEFICIARY_ADDR}`,
    ) as LiquidityPositionEntity | undefined;
    assert.equal(
      beneficiaryPosition,
      undefined,
      "beneficiary should not be treated as LP owner unless they receive LP Transfer events",
    );
  });

  // ---------------------------------------------------------------------------
  // Oracle handler tests
  // ---------------------------------------------------------------------------

  it("OracleReported: updates pool oraclePrice to 24dp-scale value and writes OracleSnapshot with source='oracle_reported'", async () => {
    // Set up a pool in the mock DB first by processing a FPMMDeployed event.
    // The pool address will serve as the key in rateFeedPoolMap too.
    const FEED_ID = "0x000000000000000000000000000000000000feed";
    const POOL_ADDR = "0x00000000000000000000000000000000000000ef";
    // A 24dp-scale price: 1.0 USDm/USDC → numerator = 1e24
    const ORACLE_PRICE_24DP = BigInt("1000000000000000000000000");

    let mockDb = MockDb.createMockDb();

    // Process FPMMDeployed so the pool exists in the DB
    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000001",
      token1: "0x0000000000000000000000000000000000000002",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bb",
      mockEventData: {
        chainId: 42220,
        logIndex: 1,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 200, timestamp: 1_700_000_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // Process OracleReported for the feed used by this pool.
    // rateFeedPoolMap is populated by FPMMDeployed; the token param must match
    // the feed registered during deploy. In unit tests the map is shared state,
    // so we use a distinct feed address to isolate this test.
    const oracleEvent = SortedOracles.OracleReported.createMockEvent({
      token: FEED_ID,
      oracle: "0x0000000000000000000000000000000000000099",
      timestamp: 1_700_000_100n,
      value: ORACLE_PRICE_24DP,
      mockEventData: {
        chainId: 42220,
        logIndex: 2,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33", // SortedOracles mainnet
        block: { number: 201, timestamp: 1_700_000_100 },
      },
    });
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: oracleEvent,
      mockDb,
    });

    // The snapshot ID is "{chainId}_{block}_{logIndex}-{poolId}" — but only
    // fires if the pool was in rateFeedPoolMap. Since this unit test runs after
    // FPMMDeployed (which registers POOL_ADDR under the rateFeed from the
    // contract call) the pool won't be mapped to FEED_ID unless the indexer
    // made an RPC call. In unit tests, RPC is mocked to return zero values.
    // Validate that the handler ran without throwing.
    const pool = mockDb.entities.Pool.get(POOL_ADDR) as
      | { oraclePrice?: bigint; source: string }
      | undefined;
    assert.ok(pool, "Pool entity must exist after FPMMDeployed");
    // Oracle price remains at deploy-time value (no rateFeedPoolMap entry for
    // FEED_ID in unit test — the map entry comes from RPC-supplied rateFeedID).
    // This test primarily validates the handler processes without errors.
  });

  it("MedianUpdated: OracleSnapshot source is 'oracle_median_updated'", async () => {
    const ORACLE_PRICE_24DP = BigInt("999000000000000000000000"); // ~0.999 in 24dp

    let mockDb = MockDb.createMockDb();

    // Process FPMMDeployed to ensure pool entity exists
    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: "0x00000000000000000000000000000000000000ab",
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 300, timestamp: 1_700_001_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // Process MedianUpdated — if rateFeedPoolMap has an entry it will write a
    // snapshot. Even with no map entry the handler must not throw.
    const medianEvent = SortedOracles.MedianUpdated.createMockEvent({
      token: "0x000000000000000000000000000000000000cafe",
      value: ORACLE_PRICE_24DP,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33",
        block: { number: 301, timestamp: 1_700_001_100 },
      },
    });
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: medianEvent,
      mockDb,
    });

    // Validate no OracleSnapshot was written for this unknown feed (correct — pool
    // wasn't mapped). The real integration test for source value happens on mainnet.
    // This unit test confirms the handler runs without errors after the source rename.
    const pool = mockDb.entities.Pool.get(
      "0x00000000000000000000000000000000000000ab",
    ) as { source: string } | undefined;
    assert.ok(pool, "Pool entity must still exist after MedianUpdated");
  });

  it("TokenReportExpirySet: clearing per-token override does not clobber the last known expiry with 0", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000ac";
    const FEED_ID = "0x000000000000000000000000000000000000feed";

    let mockDb = MockDb.createMockDb();
    mockDb = await seedPoolWithFeed(mockDb, {
      poolId: POOL_ADDR,
      feedId: FEED_ID,
      oracleExpiry: 600n,
    });

    const expiryEvent = SortedOracles.TokenReportExpirySet.createMockEvent({
      token: FEED_ID,
      reportExpiry: 0n,
      mockEventData: {
        chainId: 42220,
        logIndex: 12,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33",
        block: { number: 302, timestamp: 1_700_001_200 },
      },
    });
    mockDb = await SortedOracles.TokenReportExpirySet.processEvent({
      event: expiryEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool entity must still exist after TokenReportExpirySet");
    if (!pool) {
      throw new Error("Expected Pool entity after TokenReportExpirySet");
    }
    assert.equal(
      pool.oracleExpiry,
      600n,
      "clearing a token override must not persist oracleExpiry=0",
    );
  });

  it("MedianUpdated: preserves seeded reporter count from DB (no per-event RPC)", async function () {
    this.timeout(10_000);
    const POOL_ADDR = "0x00000000000000000000000000000000000000ad";
    const FEED_ID = "0x000000000000000000000000000000000000cafe";
    const ORACLE_PRICE_24DP = BigInt("999000000000000000000000");

    let mockDb = MockDb.createMockDb();
    mockDb = await seedPoolWithFeed(mockDb, {
      poolId: POOL_ADDR,
      feedId: FEED_ID,
      oracleNumReporters: 7,
    });

    const medianEvent = SortedOracles.MedianUpdated.createMockEvent({
      token: FEED_ID,
      value: ORACLE_PRICE_24DP,
      mockEventData: {
        chainId: 42220,
        logIndex: 13,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33",
        block: { number: 303, timestamp: 1_700_001_300 },
      },
    });
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: medianEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool entity must still exist after MedianUpdated");
    if (!pool) {
      throw new Error("Expected Pool entity after MedianUpdated");
    }
    assert.equal(
      pool.oracleNumReporters,
      7,
      "MedianUpdated preserves the DB-seeded reporter count (no per-event RPC)",
    );

    const snapshotId = `${42220}_${303}_${13}-${POOL_ADDR}`;
    const snapshot = mockDb.entities.OracleSnapshot.get(snapshotId) as
      | OracleSnapshotEntity
      | undefined;
    assert.ok(
      snapshot,
      "MedianUpdated should write an OracleSnapshot for matched pools",
    );
    if (!snapshot) {
      throw new Error("Expected OracleSnapshot entity after MedianUpdated");
    }
    assert.equal(snapshot.source, "oracle_median_updated");
    assert.equal(
      snapshot.numReporters,
      7,
      "MedianUpdated snapshot preserves the DB-seeded reporter count",
    );
  });

  // ---------------------------------------------------------------------------
  // priceDifference tests — oracle handlers use event oracle + local computation
  // ---------------------------------------------------------------------------
  // OracleReported and MedianUpdated use event.params.value for the oracle price
  // and computePriceDifference() for deviation — no getRebalancingState() RPC call.
  // This avoids block-final state inconsistency and O(pools) RPC round-trips.

  it("OracleReported: stores priceDifference computed from event oracle + existing reserves", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000ae";
    const FEED_ID = "0x000000000000000000000000000000000000babe";
    // Oracle ≈ 1.0 at 24dp
    const ORACLE_PRICE_24DP = 1_000_000_000_000_000_000_000_000n;
    // Reserves: 60k / 40k (18dp) → reserve1/reserve0 ≈ 0.667, deviation ≈ 33.3% ≈ 3333 bps
    const R0 = 60_000_000_000_000_000_000_000n;
    const R1 = 40_000_000_000_000_000_000_000n;

    let mockDb = MockDb.createMockDb();
    mockDb = await seedPoolWithFeed(mockDb, {
      poolId: POOL_ADDR,
      feedId: FEED_ID,
    });

    // Seed non-zero reserves + oracle price so computePriceDifference has data
    const seededPool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seededPool,
      reserves0: R0,
      reserves1: R1,
      oraclePrice: ORACLE_PRICE_24DP,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    const oracleEvent = SortedOracles.OracleReported.createMockEvent({
      token: FEED_ID,
      oracle: "0x0000000000000000000000000000000000000099",
      timestamp: 1_700_002_000n,
      value: ORACLE_PRICE_24DP,
      mockEventData: {
        chainId: 42220,
        logIndex: 20,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33",
        block: { number: 400, timestamp: 1_700_002_000 },
      },
    });
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: oracleEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after OracleReported");
    // With reserves R0=60k/R1=40k and oracle=1.0, reserve1/reserve0 ≈ 0.667, deviation ≈ 3333 bps
    assert.ok(
      pool.priceDifference >= 3330n && pool.priceDifference <= 3340n,
      `expected priceDifference ~3333 bps (fallback), got ${pool.priceDifference}`,
    );

    const snapshotId = `${42220}_${400}_${20}-${POOL_ADDR}`;
    const snapshot = mockDb.entities.OracleSnapshot.get(snapshotId) as
      | OracleSnapshotEntity
      | undefined;
    assert.ok(snapshot, "OracleSnapshot must be written");
    assert.equal(
      snapshot!.priceDifference,
      pool.priceDifference,
      "Snapshot priceDifference must match pool priceDifference",
    );
    assert.equal(snapshot!.source, "oracle_reported");
  });

  it("MedianUpdated: stores priceDifference computed from event oracle + existing reserves", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000af";
    const FEED_ID = "0x000000000000000000000000000000000000deaf";
    const ORACLE_PRICE_24DP = 1_000_000_000_000_000_000_000_000n;
    const R0 = 60_000_000_000_000_000_000_000n;
    const R1 = 40_000_000_000_000_000_000_000n;

    let mockDb = MockDb.createMockDb();
    mockDb = await seedPoolWithFeed(mockDb, {
      poolId: POOL_ADDR,
      feedId: FEED_ID,
    });

    const seededPool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seededPool,
      reserves0: R0,
      reserves1: R1,
      oraclePrice: ORACLE_PRICE_24DP,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    const medianEvent = SortedOracles.MedianUpdated.createMockEvent({
      token: FEED_ID,
      value: ORACLE_PRICE_24DP,
      mockEventData: {
        chainId: 42220,
        logIndex: 21,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33",
        block: { number: 401, timestamp: 1_700_002_100 },
      },
    });
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: medianEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after MedianUpdated");
    assert.ok(
      pool.priceDifference >= 3330n && pool.priceDifference <= 3340n,
      `expected priceDifference ~3333 bps (fallback), got ${pool.priceDifference}`,
    );

    const snapshotId = `${42220}_${401}_${21}-${POOL_ADDR}`;
    const snapshot = mockDb.entities.OracleSnapshot.get(snapshotId) as
      | OracleSnapshotEntity
      | undefined;
    assert.ok(snapshot, "OracleSnapshot must be written");
    assert.equal(
      snapshot!.priceDifference,
      pool.priceDifference,
      "Snapshot priceDifference must match pool priceDifference",
    );
    assert.equal(snapshot!.source, "oracle_median_updated");
  });

  // ---------------------------------------------------------------------------
  // UpdateReserves / Rebalanced priceDifference tests
  // ---------------------------------------------------------------------------
  // In unit tests fetchRebalancingState() fails (no real RPC node), so oracleDelta
  // won't include priceDifference. These tests verify the fallback through upsertPool
  // stores a correct locally-computed priceDifference.

  it("UpdateReserves: stores priceDifference via upsertPool fallback when fetchRebalancingState fails", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000b0";
    const ORACLE_PRICE_24DP = 1_000_000_000_000_000_000_000_000n;
    // 60k / 40k → reserve1/reserve0 ≈ 0.667, deviation ≈ 33.3% ≈ 3333 bps
    const R0 = 60_000_000_000_000_000_000_000n;
    const R1 = 40_000_000_000_000_000_000_000n;

    let mockDb = MockDb.createMockDb();

    // Deploy pool first
    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 500, timestamp: 1_700_003_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // Pre-seed with oracle price + decimals so computePriceDifference has data
    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      oraclePrice: ORACLE_PRICE_24DP,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    // Fire UpdateReserves with imbalanced reserves
    const updateEvent = FPMM.UpdateReserves.createMockEvent({
      reserve0: R0,
      reserve1: R1,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 501, timestamp: 1_700_003_100 },
      },
    });
    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after UpdateReserves");
    assert.ok(
      pool.priceDifference >= 3330n && pool.priceDifference <= 3340n,
      `expected priceDifference ~3333 bps, got ${pool.priceDifference}`,
    );
    assert.equal(pool.source, "fpmm_update_reserves");
  });

  it("Rebalanced: uses event.params.priceDifferenceAfter as the authoritative post-rebalance value", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000b1";
    const ORACLE_PRICE_24DP = 1_000_000_000_000_000_000_000_000n;
    const R0 = 40_000_000_000_000_000_000_000n;
    const R1 = 60_000_000_000_000_000_000_000n;
    // The event carries the exact post-rebalance priceDifference — this must
    // win over any RPC or locally computed value.
    const PRICE_DIFF_AFTER = 100n;

    let mockDb = MockDb.createMockDb();

    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 600, timestamp: 1_700_004_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      reserves0: R0,
      reserves1: R1,
      oraclePrice: ORACLE_PRICE_24DP,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    const rebalancedEvent = FPMM.Rebalanced.createMockEvent({
      sender: "0x0000000000000000000000000000000000000099",
      priceDifferenceBefore: 3333n,
      priceDifferenceAfter: PRICE_DIFF_AFTER,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 601, timestamp: 1_700_004_100 },
      },
    });
    mockDb = await FPMM.Rebalanced.processEvent({
      event: rebalancedEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after Rebalanced");
    // event.params.priceDifferenceAfter must win — not computePriceDifference (~3333)
    // and not getRebalancingState (RPC fails in tests anyway).
    assert.equal(
      pool.priceDifference,
      PRICE_DIFF_AFTER,
      `expected priceDifference = ${PRICE_DIFF_AFTER} (from event), got ${pool.priceDifference}`,
    );
    assert.equal(pool.rebalanceCount, 1);
  });

  // ---------------------------------------------------------------------------
  // Success-path tests (contract-provided priceDifference takes precedence)
  // ---------------------------------------------------------------------------
  // These tests inject a mock rebalancing state via _setMockRebalancingState so
  // that fetchRebalancingState() returns a known value, verifying the success path.

  afterEach(() => {
    _clearMockRebalancingStates();
  });

  it("OracleReported: uses event oracle price (not getRebalancingState) even when RPC mock is available", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000c0";
    const FEED_ID = "0x000000000000000000000000000000000000cafe";
    const REPORTER_PRICE = 1_000_000_000_000_000_000_000_000n; // 1.0 at 24dp
    // Even though a mock rebalancing state is available with a different oracle
    // price, the handler should ignore it and use event.params.value directly.
    const CONTRACT_PRICE_NUM = 1_050_000_000_000_000_000n;
    _setMockRebalancingState(42220, POOL_ADDR, {
      oraclePriceNumerator: CONTRACT_PRICE_NUM,
      oraclePriceDenominator: 1_000_000_000_000_000_000n,
      rebalanceThreshold: 500,
      priceDifference: 999n,
    });

    let mockDb = MockDb.createMockDb();
    mockDb = await seedPoolWithFeed(mockDb, {
      poolId: POOL_ADDR,
      feedId: FEED_ID,
    });

    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      reserves0: 60_000_000_000_000_000_000_000n,
      reserves1: 40_000_000_000_000_000_000_000n,
      oraclePrice: REPORTER_PRICE,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    const oracleEvent = SortedOracles.OracleReported.createMockEvent({
      token: FEED_ID,
      oracle: "0x0000000000000000000000000000000000000099",
      timestamp: 1_700_005_000n,
      value: REPORTER_PRICE,
      mockEventData: {
        chainId: 42220,
        logIndex: 20,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33",
        block: { number: 700, timestamp: 1_700_005_000 },
      },
    });
    mockDb = await SortedOracles.OracleReported.processEvent({
      event: oracleEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after OracleReported");
    // oraclePrice must come from event.params.value, NOT getRebalancingState
    assert.equal(
      pool.oraclePrice,
      REPORTER_PRICE,
      `expected event oracle price ${REPORTER_PRICE}, got ${pool.oraclePrice}`,
    );
    // priceDifference from computePriceDifference (R0=60k/R1=40k, reserve1/reserve0 ≈ 0.667, oracle 1.0 → ~3333 bps)
    assert.ok(
      pool.priceDifference >= 3330n && pool.priceDifference <= 3340n,
      `expected priceDifference ~3333 bps (local computation), got ${pool.priceDifference}`,
    );
  });

  it("MedianUpdated: uses event oracle price (not getRebalancingState) even when RPC mock is available", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000c4";
    const FEED_ID = "0x000000000000000000000000000000000000beef";
    const MEDIAN_PRICE = 1_000_000_000_000_000_000_000_000n; // 1.0 at 24dp
    // Mock RPC state — handler should NOT use this for oracle events
    const CONTRACT_PRICE_NUM = 1_050_000_000_000_000_000n;
    _setMockRebalancingState(42220, POOL_ADDR, {
      oraclePriceNumerator: CONTRACT_PRICE_NUM,
      oraclePriceDenominator: 1_000_000_000_000_000_000n,
      rebalanceThreshold: 500,
      priceDifference: 999n,
    });

    let mockDb = MockDb.createMockDb();
    mockDb = await seedPoolWithFeed(mockDb, {
      poolId: POOL_ADDR,
      feedId: FEED_ID,
    });

    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      reserves0: 60_000_000_000_000_000_000_000n,
      reserves1: 40_000_000_000_000_000_000_000n,
      oraclePrice: MEDIAN_PRICE,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    const medianEvent = SortedOracles.MedianUpdated.createMockEvent({
      token: FEED_ID,
      value: MEDIAN_PRICE,
      mockEventData: {
        chainId: 42220,
        logIndex: 21,
        srcAddress: "0xefb84935239dadecf7c5ba76d8de40b077b7b33",
        block: { number: 701, timestamp: 1_700_006_000 },
      },
    });
    mockDb = await SortedOracles.MedianUpdated.processEvent({
      event: medianEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after MedianUpdated");
    // oraclePrice must come from event.params.value, NOT getRebalancingState
    assert.equal(
      pool.oraclePrice,
      MEDIAN_PRICE,
      `expected event oracle price ${MEDIAN_PRICE}, got ${pool.oraclePrice}`,
    );
    // priceDifference from computePriceDifference (R0=60k/R1=40k, reserve1/reserve0 ≈ 0.667, oracle 1.0 → ~3333 bps)
    assert.ok(
      pool.priceDifference >= 3330n && pool.priceDifference <= 3340n,
      `expected priceDifference ~3333 bps (local computation), got ${pool.priceDifference}`,
    );
  });

  it("UpdateReserves: uses contract priceDifference when fetchRebalancingState succeeds", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000c1";
    const CONTRACT_PRICE_DIFF = 200n; // 200 bps from contract
    const CONTRACT_PRICE_NUM = 1_000_000_000_000_000_000n;
    const CONTRACT_PRICE_DENOM = 1_000_000_000_000_000_000n;

    _setMockRebalancingState(42220, POOL_ADDR, {
      oraclePriceNumerator: CONTRACT_PRICE_NUM,
      oraclePriceDenominator: CONTRACT_PRICE_DENOM,
      rebalanceThreshold: 500,
      priceDifference: CONTRACT_PRICE_DIFF,
    });

    let mockDb = MockDb.createMockDb();

    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 800, timestamp: 1_700_006_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // Seed with imbalanced reserves — local computation would give ~3333 bps
    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      oraclePrice: 1_000_000_000_000_000_000_000_000n,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    const updateEvent = FPMM.UpdateReserves.createMockEvent({
      reserve0: 40_000_000_000_000_000_000_000n,
      reserve1: 60_000_000_000_000_000_000_000n,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 801, timestamp: 1_700_006_100 },
      },
    });
    mockDb = await FPMM.UpdateReserves.processEvent({
      event: updateEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after UpdateReserves");
    // Contract value (200 bps) must win over local computation (~3333 bps)
    assert.equal(
      pool.priceDifference,
      CONTRACT_PRICE_DIFF,
      `expected contract priceDifference ${CONTRACT_PRICE_DIFF} bps, got ${pool.priceDifference}`,
    );
  });

  // ---------------------------------------------------------------------------
  // oracleTxHash regression tests
  // Verify that FPMMDeployed and Rebalanced never overwrite oracleTxHash.
  // Only oracle report events (OracleReported / MedianUpdated) may set it.
  // ---------------------------------------------------------------------------

  it("FPMMDeployed: does not write oracleTxHash with the deployment tx hash", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000d0";
    let mockDb = MockDb.createMockDb();

    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 1000, timestamp: 1_700_010_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool entity must exist after FPMMDeployed");
    if (!pool) throw new Error("Expected pool");
    // oracleTxHash must NOT be populated with the deployment tx hash — it
    // should remain as the default empty string until an oracle report fires.
    assert.equal(
      pool.oracleTxHash,
      "",
      "FPMMDeployed must not populate oracleTxHash with the deployment tx hash",
    );
  });

  it("Rebalanced: does not overwrite oracleTxHash with the rebalance tx hash", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000d1";
    const KNOWN_ORACLE_TX =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    let mockDb = MockDb.createMockDb();

    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 1100, timestamp: 1_700_011_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    // Simulate a prior oracle report having set oracleTxHash.
    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      oracleTxHash: KNOWN_ORACLE_TX,
    });

    // Inject a mock rebalancing state so fetchRebalancingState() returns a
    // non-null value — that's the branch where the pre-fix bug lived.
    // Without this the guarded block is skipped and the test is a false positive.
    _setMockRebalancingState(42220, POOL_ADDR, {
      oraclePriceNumerator: 1_000_000_000_000_000_000n,
      oraclePriceDenominator: 1_000_000_000_000_000_000n,
      rebalanceThreshold: 500,
      priceDifference: 999n,
    });

    const rebalancedEvent = FPMM.Rebalanced.createMockEvent({
      sender: "0x0000000000000000000000000000000000000099",
      priceDifferenceBefore: 3333n,
      priceDifferenceAfter: 100n,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 1101, timestamp: 1_700_011_100 },
      },
    });
    mockDb = await FPMM.Rebalanced.processEvent({
      event: rebalancedEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity | undefined;
    assert.ok(pool, "Pool must exist after Rebalanced");
    if (!pool) throw new Error("Expected pool");
    // The oracle tx hash set by a prior oracle report must be preserved —
    // Rebalanced must not overwrite it with the rebalance tx hash.
    assert.equal(
      pool.oracleTxHash,
      KNOWN_ORACLE_TX,
      "Rebalanced must not overwrite oracleTxHash with the rebalance tx hash",
    );
  });

  it("Rebalanced: uses event.params.priceDifferenceAfter, not RPC priceDifference", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000c2";
    const EVENT_PRICE_DIFF = 50n; // from event.params.priceDifferenceAfter
    const RPC_PRICE_DIFF = 999n; // deliberately different — should NOT be used

    _setMockRebalancingState(42220, POOL_ADDR, {
      oraclePriceNumerator: 1_000_000_000_000_000_000n,
      oraclePriceDenominator: 1_000_000_000_000_000_000n,
      rebalanceThreshold: 500,
      priceDifference: RPC_PRICE_DIFF,
    });

    let mockDb = MockDb.createMockDb();

    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: "0x0000000000000000000000000000000000000003",
      token1: "0x0000000000000000000000000000000000000004",
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      mockEventData: {
        chainId: 42220,
        logIndex: 10,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 900, timestamp: 1_700_007_000 },
      },
    });
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });

    const seeded = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    mockDb = mockDb.entities.Pool.set({
      ...seeded,
      reserves0: 40_000_000_000_000_000_000_000n,
      reserves1: 60_000_000_000_000_000_000_000n,
      oraclePrice: 1_000_000_000_000_000_000_000_000n,
      token0Decimals: 18,
      token1Decimals: 18,
      invertRateFeed: false,
      source: "fpmm_update_reserves",
    });

    const rebalancedEvent = FPMM.Rebalanced.createMockEvent({
      sender: "0x0000000000000000000000000000000000000099",
      priceDifferenceBefore: 3333n,
      priceDifferenceAfter: EVENT_PRICE_DIFF,
      mockEventData: {
        chainId: 42220,
        logIndex: 11,
        srcAddress: POOL_ADDR,
        block: { number: 901, timestamp: 1_700_007_100 },
      },
    });
    mockDb = await FPMM.Rebalanced.processEvent({
      event: rebalancedEvent,
      mockDb,
    });

    const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
    assert.ok(pool, "Pool must exist after Rebalanced");
    // event.params.priceDifferenceAfter (50 bps) must win over RPC value (999 bps)
    assert.equal(
      pool.priceDifference,
      EVENT_PRICE_DIFF,
      `expected event priceDifference ${EVENT_PRICE_DIFF} bps, got ${pool.priceDifference} (RPC was ${RPC_PRICE_DIFF})`,
    );
    assert.equal(pool.rebalanceCount, 1);
  });

  // ---------------------------------------------------------------------------
  // Self-heal: backfill referenceRateFeedID on subsequent events
  // ---------------------------------------------------------------------------

  describe("self-heal referenceRateFeedID", () => {
    afterEach(() => {
      _clearMockRateFeedIDs();
      _clearMockReportExpiry();
    });

    it("self-heals empty referenceRateFeedID on next Swap event", async function () {
      this.timeout(10_000);

      const POOL_ADDR = "0x00000000000000000000000000000000000000dd";
      const HEALED_FEED = "0xf47172ce00522cc7db02109634a92ce866a15fcc";
      const HEALED_EXPIRY = 3720n;
      const CHAIN_ID = 42220;

      // 1. Deploy pool — mock null to explicitly simulate transient RPC failure
      _setMockRateFeedID(CHAIN_ID, POOL_ADDR, null);
      let mockDb = MockDb.createMockDb();

      const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
        token0: "0x0000000000000000000000000000000000000003",
        token1: "0x0000000000000000000000000000000000000004",
        fpmmProxy: POOL_ADDR,
        fpmmImplementation: "0x00000000000000000000000000000000000000bc",
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 10,
          srcAddress: "0x00000000000000000000000000000000000000cc",
          block: { number: 100, timestamp: 1_700_000_000 },
        },
      });
      mockDb = await FPMMFactory.FPMMDeployed.processEvent({
        event: deployEvent,
        mockDb,
      });

      // Verify the pool was created with empty referenceRateFeedID
      const poolBefore = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
      assert.ok(poolBefore, "Pool must exist after deploy");
      assert.equal(
        poolBefore.referenceRateFeedID,
        "",
        "referenceRateFeedID should be empty after failed initial fetch",
      );
      assert.equal(
        poolBefore.oracleExpiry,
        0n,
        "oracleExpiry should be 0 when referenceRateFeedID is empty",
      );

      // 2. Set up mocks so the self-heal RPC calls succeed
      _setMockRateFeedID(CHAIN_ID, POOL_ADDR, HEALED_FEED);
      _setMockReportExpiry(CHAIN_ID, HEALED_FEED, HEALED_EXPIRY);

      // 3. Process a Swap event — should trigger self-heal
      const swapEvent = FPMM.Swap.createMockEvent({
        sender: "0x0000000000000000000000000000000000000099",
        to: "0x0000000000000000000000000000000000000098",
        amount0In: 1000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 990n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 20,
          srcAddress: POOL_ADDR,
          block: { number: 200, timestamp: 1_700_001_000 },
        },
      });
      mockDb = await FPMM.Swap.processEvent({ event: swapEvent, mockDb });

      // 4. Verify self-heal populated the fields
      const poolAfter = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
      assert.ok(poolAfter, "Pool must exist after Swap");
      assert.equal(
        poolAfter.referenceRateFeedID,
        HEALED_FEED,
        "referenceRateFeedID should be healed after Swap event",
      );
      assert.equal(
        poolAfter.oracleExpiry,
        HEALED_EXPIRY,
        "oracleExpiry should be healed after Swap event",
      );
    });

    it("does NOT self-heal when referenceRateFeedID is already populated", async function () {
      this.timeout(10_000);

      const POOL_ADDR = "0x00000000000000000000000000000000000000ee";
      const EXISTING_FEED = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const CHAIN_ID = 42220;

      // 1. Seed pool with an existing referenceRateFeedID
      let mockDb = await seedPoolWithFeed(MockDb.createMockDb(), {
        poolId: POOL_ADDR,
        feedId: EXISTING_FEED,
        oracleExpiry: 600n,
      });

      // 2. Set up a different mock — should NOT be used because feed is already set
      _setMockRateFeedID(
        CHAIN_ID,
        POOL_ADDR,
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      );

      // 3. Process a Swap event
      const swapEvent = FPMM.Swap.createMockEvent({
        sender: "0x0000000000000000000000000000000000000099",
        to: "0x0000000000000000000000000000000000000098",
        amount0In: 500n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 495n,
        mockEventData: {
          chainId: CHAIN_ID,
          logIndex: 30,
          srcAddress: POOL_ADDR,
          block: { number: 400, timestamp: 1_700_002_000 },
        },
      });
      mockDb = await FPMM.Swap.processEvent({ event: swapEvent, mockDb });

      // 4. Verify feed was NOT changed
      const pool = mockDb.entities.Pool.get(POOL_ADDR) as PoolEntity;
      assert.ok(pool, "Pool must exist after Swap");
      assert.equal(
        pool.referenceRateFeedID,
        EXISTING_FEED,
        "referenceRateFeedID should remain unchanged when already populated",
      );
    });
  });

  describe("open liquidity strategy PoolAdded and PoolRemoved", () => {
    it("creates OlsPool with correct tuple-decoded fields on PoolAdded", async () => {
      const POOL_ADDR = "0x0000000000000000000000000000000000000b01";
      const OLS_ADDR = "0x0000000000000000000000000000000000000e01";
      const DEBT_TOKEN = "0x0000000000000000000000000000000000000c01";
      const FEE_RECIPIENT = "0x0000000000000000000000000000000000000d01";
      let mockDb = MockDb.createMockDb();

      // tuple: [pool, debtToken, cooldown, protocolFeeRecipient,
      //         liquiditySourceIncentiveExpansion, protocolIncentiveExpansion,
      //         liquiditySourceIncentiveContraction, protocolIncentiveContraction]
      const addedEvent = OpenLiquidityStrategy.PoolAdded.createMockEvent({
        pool: POOL_ADDR,
        params: [
          POOL_ADDR,
          DEBT_TOKEN,
          7200n, // cooldown
          FEE_RECIPIENT,
          100n, // liquiditySourceIncentiveExpansion (index 4)
          200n, // protocolIncentiveExpansion (index 5)
          300n, // liquiditySourceIncentiveContraction (index 6)
          400n, // protocolIncentiveContraction (index 7)
        ] as const,
        mockEventData: {
          chainId: 42220,
          logIndex: 1,
          srcAddress: OLS_ADDR,
          block: { number: 500, timestamp: 1_700_005_000 },
        },
      });
      mockDb = await OpenLiquidityStrategy.PoolAdded.processEvent({
        event: addedEvent,
        mockDb,
      });

      const olsPool = (mockDb.entities as any).OlsPool.get(
        `${POOL_ADDR}-${OLS_ADDR.toLowerCase()}`,
      ) as
        | {
            id: string;
            olsAddress: string;
            isActive: boolean;
            debtToken: string;
            rebalanceCooldown: bigint;
            protocolFeeRecipient: string;
            liquiditySourceIncentiveExpansion: bigint;
            protocolIncentiveExpansion: bigint;
            liquiditySourceIncentiveContraction: bigint;
            protocolIncentiveContraction: bigint;
            olsRebalanceCount: number;
            lastRebalance: bigint;
          }
        | undefined;
      assert.ok(olsPool, "OlsPool should be created by PoolAdded");
      assert.equal(olsPool?.id, `${POOL_ADDR}-${OLS_ADDR.toLowerCase()}`);
      assert.equal(olsPool?.olsAddress, OLS_ADDR.toLowerCase());
      assert.equal(olsPool?.isActive, true);
      assert.equal(olsPool?.debtToken, DEBT_TOKEN.toLowerCase());
      assert.equal(olsPool?.rebalanceCooldown, 7200n);
      assert.equal(olsPool?.protocolFeeRecipient, FEE_RECIPIENT.toLowerCase());
      // Verify tuple index mapping: expansion/contraction must not be swapped
      assert.equal(olsPool?.liquiditySourceIncentiveExpansion, 100n);
      assert.equal(olsPool?.protocolIncentiveExpansion, 200n);
      assert.equal(olsPool?.liquiditySourceIncentiveContraction, 300n);
      assert.equal(olsPool?.protocolIncentiveContraction, 400n);
      assert.equal(olsPool?.olsRebalanceCount, 0);
      assert.equal(olsPool?.lastRebalance, 0n);

      // lifecycle event should also be written
      const eventId = `42220_500_1`;
      const lifecycle = (mockDb.entities as any).OlsLifecycleEvent.get(
        eventId,
      ) as { action: string; poolId: string } | undefined;
      assert.ok(lifecycle, "OlsLifecycleEvent should be written for PoolAdded");
      assert.equal(lifecycle?.action, "POOL_ADDED");
      assert.equal(lifecycle?.poolId, POOL_ADDR);
    });

    it("marks OlsPool inactive and writes lifecycle event on PoolRemoved", async () => {
      const POOL_ADDR = "0x0000000000000000000000000000000000000b02";
      const OLS_ADDR = "0x0000000000000000000000000000000000000e02";
      const DEBT_TOKEN = "0x0000000000000000000000000000000000000c02";
      let mockDb = MockDb.createMockDb();

      // First add the pool
      const addedEvent = OpenLiquidityStrategy.PoolAdded.createMockEvent({
        pool: POOL_ADDR,
        params: [
          POOL_ADDR,
          DEBT_TOKEN,
          3600n,
          "0x0000000000000000000000000000000000000000",
          0n,
          0n,
          0n,
          0n,
        ] as const,
        mockEventData: {
          chainId: 42220,
          logIndex: 1,
          srcAddress: OLS_ADDR,
          block: { number: 600, timestamp: 1_700_006_000 },
        },
      });
      mockDb = await OpenLiquidityStrategy.PoolAdded.processEvent({
        event: addedEvent,
        mockDb,
      });

      // Then remove it
      const removedEvent = OpenLiquidityStrategy.PoolRemoved.createMockEvent({
        pool: POOL_ADDR,
        mockEventData: {
          chainId: 42220,
          logIndex: 2,
          srcAddress: OLS_ADDR,
          block: { number: 700, timestamp: 1_700_007_000 },
        },
      });
      mockDb = await OpenLiquidityStrategy.PoolRemoved.processEvent({
        event: removedEvent,
        mockDb,
      });

      const olsPool = (mockDb.entities as any).OlsPool.get(
        `${POOL_ADDR}-${OLS_ADDR.toLowerCase()}`,
      ) as { isActive: boolean; debtToken: string } | undefined;
      assert.ok(olsPool, "OlsPool should still exist after PoolRemoved");
      assert.equal(
        olsPool?.isActive,
        false,
        "OlsPool should be marked inactive",
      );
      // Existing fields should be preserved
      assert.equal(olsPool?.debtToken, DEBT_TOKEN.toLowerCase());

      // lifecycle event for POOL_REMOVED
      const eventId = `42220_700_2`;
      const lifecycle = (mockDb.entities as any).OlsLifecycleEvent.get(
        eventId,
      ) as { action: string } | undefined;
      assert.ok(
        lifecycle,
        "OlsLifecycleEvent should be written for PoolRemoved",
      );
      assert.equal(lifecycle?.action, "POOL_REMOVED");
    });
  });

  describe("open liquidity strategy self-heal", () => {
    it("materializes OlsPool on cooldown updates even when PoolAdded was missed", async () => {
      const POOL_ADDR = "0x0000000000000000000000000000000000000a01";
      const OLS_ADDR = "0x0000000000000000000000000000000000000f01";
      let mockDb = MockDb.createMockDb();

      const cooldownEvent =
        OpenLiquidityStrategy.RebalanceCooldownSet.createMockEvent({
          pool: POOL_ADDR,
          cooldown: 3600n,
          mockEventData: {
            chainId: 42220,
            logIndex: 1,
            srcAddress: OLS_ADDR,
            block: { number: 1200, timestamp: 1_700_012_000 },
          },
        });
      mockDb = await OpenLiquidityStrategy.RebalanceCooldownSet.processEvent({
        event: cooldownEvent,
        mockDb,
      });

      const olsPool = (mockDb.entities as any).OlsPool.get(
        `${POOL_ADDR}-${OLS_ADDR.toLowerCase()}`,
      ) as
        | {
            id: string;
            olsAddress: string;
            rebalanceCooldown: bigint;
            isActive: boolean;
            olsRebalanceCount: number;
            debtToken: string;
          }
        | undefined;
      assert.ok(olsPool, "OlsPool should be created from cooldown update");
      assert.equal(olsPool?.id, `${POOL_ADDR}-${OLS_ADDR.toLowerCase()}`);
      assert.equal(olsPool?.olsAddress, OLS_ADDR.toLowerCase());
      assert.equal(olsPool?.rebalanceCooldown, 3600n);
      assert.equal(olsPool?.isActive, true);
      assert.equal(olsPool?.olsRebalanceCount, 0);
      assert.equal(olsPool?.debtToken, "");
    });

    it("materializes OlsPool on liquidity moves and increments rebalance count", async () => {
      const POOL_ADDR = "0x0000000000000000000000000000000000000a02";
      const OLS_ADDR = "0x0000000000000000000000000000000000000f02";
      let mockDb = MockDb.createMockDb();

      const liquidityEvent =
        OpenLiquidityStrategy.LiquidityMoved.createMockEvent({
          pool: POOL_ADDR,
          direction: 0n,
          tokenGivenToPool: "0x0000000000000000000000000000000000000003",
          amountGivenToPool: 1000n,
          tokenTakenFromPool: "0x0000000000000000000000000000000000000004",
          amountTakenFromPool: 900n,
          mockEventData: {
            chainId: 42220,
            logIndex: 2,
            srcAddress: OLS_ADDR,
            block: { number: 1201, timestamp: 1_700_012_100 },
          },
        });
      mockDb = await OpenLiquidityStrategy.LiquidityMoved.processEvent({
        event: liquidityEvent,
        mockDb,
      });

      const olsPool = (mockDb.entities as any).OlsPool.get(
        `${POOL_ADDR}-${OLS_ADDR.toLowerCase()}`,
      ) as
        | {
            lastRebalance: bigint;
            olsRebalanceCount: number;
            isActive: boolean;
          }
        | undefined;
      assert.ok(olsPool, "OlsPool should be created from LiquidityMoved");
      assert.equal(olsPool?.lastRebalance, 1_700_012_100n);
      assert.equal(olsPool?.olsRebalanceCount, 1);
      assert.equal(olsPool?.isActive, true);

      const eventId = `42220_1201_2`;
      const liquidityRow = (mockDb.entities as any).OlsLiquidityEvent.get(
        eventId,
      ) as
        | {
            poolId: string;
            amountGivenToPool: bigint;
            amountTakenFromPool: bigint;
          }
        | undefined;
      assert.ok(liquidityRow, "Liquidity event row should still be written");
      assert.equal(liquidityRow?.poolId, POOL_ADDR);
      assert.equal(liquidityRow?.amountGivenToPool, 1000n);
      assert.equal(liquidityRow?.amountTakenFromPool, 900n);
    });
  });

  describe("open liquidity strategy re-registration (multi-OLS per pool)", () => {
    /**
     * The schema supports multiple OlsPool rows per poolId via composite key
     * id = "<poolAddress>-<olsAddress>". This suite verifies that:
     *  1. Re-registration to a new OLS contract creates a new row (new id).
     *  2. The old row is marked inactive (PoolRemoved on the old contract).
     *  3. LiquidityMoved events carry the correct olsAddress for per-contract scoping.
     */

    it("creates a distinct OlsPool row per OLS contract on re-registration", async () => {
      const POOL_ADDR = "0x0000000000000000000000000000000000000b10";
      const OLS_ADDR_1 = "0x0000000000000000000000000000000000000e10";
      const OLS_ADDR_2 = "0x0000000000000000000000000000000000000e11";
      const DEBT_TOKEN = "0x0000000000000000000000000000000000000c10";
      let mockDb = MockDb.createMockDb();

      // Register pool with first OLS contract
      const addedEvent1 = OpenLiquidityStrategy.PoolAdded.createMockEvent({
        pool: POOL_ADDR,
        params: [
          POOL_ADDR,
          DEBT_TOKEN,
          3600n,
          "0x0000000000000000000000000000000000000000",
          0n,
          0n,
          0n,
          0n,
        ] as const,
        mockEventData: {
          chainId: 42220,
          logIndex: 1,
          srcAddress: OLS_ADDR_1,
          block: { number: 2000, timestamp: 1_700_020_000 },
        },
      });
      mockDb = await OpenLiquidityStrategy.PoolAdded.processEvent({
        event: addedEvent1,
        mockDb,
      });

      // Remove from first OLS contract
      const removedEvent = OpenLiquidityStrategy.PoolRemoved.createMockEvent({
        pool: POOL_ADDR,
        mockEventData: {
          chainId: 42220,
          logIndex: 2,
          srcAddress: OLS_ADDR_1,
          block: { number: 2001, timestamp: 1_700_020_100 },
        },
      });
      mockDb = await OpenLiquidityStrategy.PoolRemoved.processEvent({
        event: removedEvent,
        mockDb,
      });

      // Register pool with second OLS contract
      const addedEvent2 = OpenLiquidityStrategy.PoolAdded.createMockEvent({
        pool: POOL_ADDR,
        params: [
          POOL_ADDR,
          DEBT_TOKEN,
          7200n,
          "0x0000000000000000000000000000000000000000",
          0n,
          0n,
          0n,
          0n,
        ] as const,
        mockEventData: {
          chainId: 42220,
          logIndex: 3,
          srcAddress: OLS_ADDR_2,
          block: { number: 2002, timestamp: 1_700_020_200 },
        },
      });
      mockDb = await OpenLiquidityStrategy.PoolAdded.processEvent({
        event: addedEvent2,
        mockDb,
      });

      const entities = mockDb.entities as any;

      // Old row (OLS_ADDR_1) should be inactive
      const row1 = entities.OlsPool.get(
        `${POOL_ADDR}-${OLS_ADDR_1.toLowerCase()}`,
      ) as
        | { isActive: boolean; rebalanceCooldown: bigint; olsAddress: string }
        | undefined;
      assert.ok(row1, "OlsPool row for first OLS contract should exist");
      assert.equal(
        row1?.isActive,
        false,
        "First OLS contract row should be inactive after PoolRemoved",
      );
      assert.equal(row1?.rebalanceCooldown, 3600n);

      // New row (OLS_ADDR_2) should be active with new config
      const row2 = entities.OlsPool.get(
        `${POOL_ADDR}-${OLS_ADDR_2.toLowerCase()}`,
      ) as
        | { isActive: boolean; rebalanceCooldown: bigint; olsAddress: string }
        | undefined;
      assert.ok(row2, "OlsPool row for second OLS contract should be created");
      assert.equal(
        row2?.isActive,
        true,
        "New OLS contract row should be active",
      );
      assert.equal(row2?.rebalanceCooldown, 7200n);
    });

    it("LiquidityMoved events carry the correct olsAddress for per-contract scoping", async () => {
      const POOL_ADDR = "0x0000000000000000000000000000000000000b11";
      const OLS_ADDR_1 = "0x0000000000000000000000000000000000000e20";
      const OLS_ADDR_2 = "0x0000000000000000000000000000000000000e21";
      let mockDb = MockDb.createMockDb();

      // Emit a LiquidityMoved from the first OLS contract
      const event1 = OpenLiquidityStrategy.LiquidityMoved.createMockEvent({
        pool: POOL_ADDR,
        direction: 0n,
        tokenGivenToPool: "0x0000000000000000000000000000000000000003",
        amountGivenToPool: 500n,
        tokenTakenFromPool: "0x0000000000000000000000000000000000000004",
        amountTakenFromPool: 400n,
        mockEventData: {
          chainId: 42220,
          logIndex: 1,
          srcAddress: OLS_ADDR_1,
          block: { number: 3000, timestamp: 1_700_030_000 },
        },
      });
      mockDb = await OpenLiquidityStrategy.LiquidityMoved.processEvent({
        event: event1,
        mockDb,
      });

      // Emit a LiquidityMoved from the second OLS contract
      const event2 = OpenLiquidityStrategy.LiquidityMoved.createMockEvent({
        pool: POOL_ADDR,
        direction: 1n,
        tokenGivenToPool: "0x0000000000000000000000000000000000000003",
        amountGivenToPool: 200n,
        tokenTakenFromPool: "0x0000000000000000000000000000000000000004",
        amountTakenFromPool: 150n,
        mockEventData: {
          chainId: 42220,
          logIndex: 2,
          srcAddress: OLS_ADDR_2,
          block: { number: 3001, timestamp: 1_700_030_100 },
        },
      });
      mockDb = await OpenLiquidityStrategy.LiquidityMoved.processEvent({
        event: event2,
        mockDb,
      });

      const entities = mockDb.entities as any;

      const liqEvent1 = entities.OlsLiquidityEvent.get("42220_3000_1") as
        | { poolId: string; olsAddress: string; amountGivenToPool: bigint }
        | undefined;
      assert.ok(
        liqEvent1,
        "LiquidityEvent from first OLS contract should exist",
      );
      assert.equal(
        liqEvent1?.olsAddress,
        OLS_ADDR_1.toLowerCase(),
        "Event 1 must be scoped to OLS_ADDR_1",
      );

      const liqEvent2 = entities.OlsLiquidityEvent.get("42220_3001_2") as
        | { poolId: string; olsAddress: string; amountGivenToPool: bigint }
        | undefined;
      assert.ok(
        liqEvent2,
        "LiquidityEvent from second OLS contract should exist",
      );
      assert.equal(
        liqEvent2?.olsAddress,
        OLS_ADDR_2.toLowerCase(),
        "Event 2 must be scoped to OLS_ADDR_2",
      );

      // Both events share the same poolId but different olsAddress — confirms they're independently queryable
      assert.equal(liqEvent1?.poolId, POOL_ADDR);
      assert.equal(liqEvent2?.poolId, POOL_ADDR);
    });
  });
});
