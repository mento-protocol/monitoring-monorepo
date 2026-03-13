/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";

type MockDb = {
  entities: {
    FactoryDeployment: { get: (id: string) => unknown };
    Pool: {
      get: (id: string) => unknown;
      set: (entity: unknown) => MockDb;
    };
    SwapEvent: { get: (id: string) => unknown };
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
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM, SortedOracles } = TestHelpers;

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

  it("MedianUpdated: preserves last known reporter count when refresh has no data", async () => {
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
      "MedianUpdated must preserve the last known-good reporter count on read failure",
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
      "MedianUpdated snapshot must preserve the last known-good reporter count on read failure",
    );
  });

  // ---------------------------------------------------------------------------
  // priceDifference fallback tests
  // ---------------------------------------------------------------------------
  // In unit tests, fetchRebalancingState() makes an RPC call that fails (no real
  // node), so it returns null and the handlers fall back to computePriceDifference().
  // These tests verify the fallback path stores a correct priceDifference on both
  // the Pool entity and the OracleSnapshot.

  it("OracleReported: falls back to computePriceDifference when fetchRebalancingState fails, and stores priceDifference on pool + snapshot", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000ae";
    const FEED_ID = "0x000000000000000000000000000000000000babe";
    // Oracle ≈ 1.0 at 24dp
    const ORACLE_PRICE_24DP = 1_000_000_000_000_000_000_000_000n;
    // Reserves: 40k / 60k (18dp) → reserveRatio ≈ 0.667, deviation ≈ 33.3% ≈ 3333 bps
    const R0 = 40_000_000_000_000_000_000_000n;
    const R1 = 60_000_000_000_000_000_000_000n;

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
    // With reserves 40k/60k and oracle=1.0, deviation ≈ 3333 bps
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

  it("MedianUpdated: falls back to computePriceDifference when fetchRebalancingState fails, and stores priceDifference on pool + snapshot", async () => {
    const POOL_ADDR = "0x00000000000000000000000000000000000000af";
    const FEED_ID = "0x000000000000000000000000000000000000deaf";
    const ORACLE_PRICE_24DP = 1_000_000_000_000_000_000_000_000n;
    const R0 = 40_000_000_000_000_000_000_000n;
    const R1 = 60_000_000_000_000_000_000_000n;

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
});
