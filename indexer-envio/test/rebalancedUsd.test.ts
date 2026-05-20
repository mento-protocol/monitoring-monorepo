import assert from "node:assert/strict";
import { createTestIndexer } from "envio";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockEntity,
  type MockDbWith,
  type MockEventData,
  type WritableEntity,
} from "./helpers/indexerTestHarness.js";
import {
  createMockEventData,
  seedFpmmPoolFixture,
} from "./helpers/eventFixtures.js";
import { makePoolId } from "../src/helpers.ts";
import {
  fetchRebalancingState,
  _setMockRebalancingState,
  _setMockReserves,
  _clearMockReserves,
  _clearMockRebalancingStates,
  _setMockRebalanceIncentiveAtBlock,
  _clearMockRebalanceIncentivesAtBlock,
  _setMockRebalanceThresholds,
  _clearMockRebalanceThresholds,
} from "../src/rpc.ts";

type MockDb = MockDbWith<{
  Pool: WritableEntity;
  RebalanceEvent: EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

type NormalizedMockEvent = {
  contractName: string;
  eventName: string;
  params: Record<string, unknown>;
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: Record<string, unknown>;
};

// Real Celo mainnet addresses — resolvable via KNOWN_TOKEN_META so
// computeRebalanceUsd's symbol lookup succeeds.
const CHAIN_CELO = 42220;
const POOL = "0x00000000000000000000000000000000000000aa";
const FACTORY = "0x00000000000000000000000000000000000000cc";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a"; // 18dp, pegged
const CELO = "0x471ece3750da237f93b8e339c536989b8978a438"; // 18dp, NOT pegged
const STRATEGY = "0x0000000000000000000000000000000000000099";
const TX_FROM = "0x000000000000000000000000000000000000ca11";

function rebalancedEventData(
  blockNumber: number,
  logIndex = 5,
  txHash = `0x${"ab".repeat(32)}`,
): MockEventData {
  return createMockEventData({
    chainId: CHAIN_CELO,
    logIndex,
    srcAddress: POOL,
    blockNumber,
    blockTimestamp: 1_700_010_000,
    transaction: { hash: txHash, from: TX_FROM },
  });
}

async function processEventsInOneBatch(
  mockDb: MockDb,
  events: readonly unknown[],
): Promise<MockDb> {
  const indexer = createTestIndexer();
  const target = indexer as unknown as Record<
    string,
    { set?: (entity: MockEntity) => void }
  >;
  for (const [entityName, rows] of mockDb._stores) {
    const ops = target[entityName];
    if (!ops?.set) continue;
    for (const entity of rows.values()) {
      ops.set(entity);
    }
  }

  const normalized = events as readonly NormalizedMockEvent[];
  const first = normalized[0];
  assert.ok(first, "processEventsInOneBatch requires at least one event");
  const block = Number(first.block.number);
  const chainId = first.chainId;
  const result = await indexer.process({
    chains: {
      [chainId]: {
        startBlock: block,
        endBlock: block,
        simulate: normalized.map((event) => ({
          contract: event.contractName,
          event: event.eventName,
          srcAddress: event.srcAddress,
          logIndex: event.logIndex,
          block: event.block,
          transaction: event.transaction,
          params: event.params,
        })),
      },
    },
  });

  for (const change of result.changes as Array<Record<string, unknown>>) {
    for (const [entityName, value] of Object.entries(change)) {
      if (
        entityName === "block" ||
        entityName === "chainId" ||
        entityName === "eventsProcessed" ||
        entityName === "addresses"
      ) {
        continue;
      }
      const entityChange = value as
        | { sets?: MockEntity[]; deleted?: string[] }
        | undefined;
      if (!entityChange) continue;
      const store = mockDb.entities[entityName];
      for (const entity of entityChange.sets ?? []) {
        store.set(entity);
      }
      for (const id of entityChange.deleted ?? []) {
        mockDb._stores.get(entityName)?.delete(id);
      }
    }
  }

  return mockDb;
}

async function seedRebalanceablePool(
  mockDb: MockDb,
  options: {
    rebalanceReward: number;
    reserves0: bigint;
    reserves1: bigint;
    token0?: string;
    token1?: string;
    token0Decimals?: number;
    token1Decimals?: number;
  },
): Promise<MockDb> {
  mockDb = await seedFpmmPoolFixture(mockDb, FPMMFactory.FPMMDeployed, {
    token0: options.token0 ?? USDM,
    token1: options.token1 ?? CELO,
    poolAddress: POOL,
    factoryAddress: FACTORY,
    blockNumber: 100,
    blockTimestamp: 1_700_000_000,
  });

  const seeded = mockDb.entities.Pool.get(makePoolId(CHAIN_CELO, POOL)) as
    | Record<string, unknown>
    | undefined;
  assert.ok(seeded, "Pool must exist after FPMMDeployed");
  return mockDb.entities.Pool.set({
    ...seeded,
    token0: options.token0 ?? USDM,
    token1: options.token1 ?? CELO,
    token0Decimals: options.token0Decimals ?? 18,
    token1Decimals: options.token1Decimals ?? 18,
    tokenDecimalsKnown: true,
    reserves0: options.reserves0,
    reserves1: options.reserves1,
    rebalanceReward: options.rebalanceReward,
    oraclePrice: 1_000_000_000_000_000_000_000_000n,
    invertRateFeed: false,
    source: "fpmm_update_reserves",
  });
}

describe("FPMM.Rebalanced handler — USD profit fields", () => {
  beforeEach(() => {
    _clearMockReserves();
    _clearMockRebalancingStates();
    _clearMockRebalanceIncentivesAtBlock();
    _clearMockRebalanceThresholds();
    // Seed mock thresholds for the test pool so the factory's
    // rebalanceThresholdsEffect (now block-scoped, cache: false) doesn't
    // hit live RPC during FPMMDeployed processing.
    _setMockRebalanceThresholds(CHAIN_CELO, POOL, { above: 100, below: 100 });
  });

  afterAll(() => {
    _clearMockReserves();
    _clearMockRebalancingStates();
    _clearMockRebalanceIncentivesAtBlock();
    _clearMockRebalanceThresholds();
  });

  it("returns an installed null rebalancing-state mock without falling through to RPC", async function () {
    const warnMessages: unknown[] = [];
    _setMockRebalancingState(CHAIN_CELO, POOL, null);

    const state = await fetchRebalancingState(CHAIN_CELO, POOL, 600n, {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warnMessages.push(args);
      },
      error: () => undefined,
    });

    assert.equal(state, null);
    assert.equal(
      warnMessages.length,
      0,
      "null mock must be treated as installed, not as a missing mock that falls through to RPC",
    );
  });

  it("stamps amount deltas + USD fields from block-scoped incentive read", async function () {
    let mockDb = MockDb.createMockDb();
    // Pool reserves AFTER the rebalance: pool received 1000 USDM, gave away 500 CELO.
    mockDb = await seedRebalanceablePool(mockDb, {
      rebalanceReward: 999, // would be wrong if used — block-scoped read should win
      reserves0: 101_000n * 10n ** 18n,
      reserves1: 49_500n * 10n ** 18n,
    });
    // Pre-rebalance reserves at blockNumber - 1.
    _setMockReserves(CHAIN_CELO, POOL, {
      reserve0: 100_000n * 10n ** 18n,
      reserve1: 50_000n * 10n ** 18n,
    });
    // Block-scoped incentive: 25 bps. Distinct from Pool.rebalanceReward=999
    // so we can prove the handler used the block-scoped value.
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, 25);

    const event = FPMM.Rebalanced.createMockEvent({
      sender: STRATEGY,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
      mockEventData: rebalancedEventData(601, 5),
    });
    mockDb = await FPMM.Rebalanced.processEvent({ event, mockDb });

    const id = `${CHAIN_CELO}_601_5`;
    const rebalance = mockDb.entities.RebalanceEvent.get(id) as
      | {
          amount0Delta: bigint;
          amount1Delta: bigint;
          rewardBps: number;
          notionalUsd: string;
          rewardUsd: string;
        }
      | undefined;
    assert.ok(rebalance, "RebalanceEvent must be persisted");
    assert.equal(rebalance.amount0Delta, 1_000n * 10n ** 18n);
    assert.equal(rebalance.amount1Delta, -500n * 10n ** 18n);
    assert.equal(
      rebalance.rewardBps,
      25,
      "rewardBps must come from block-scoped read, not Pool.rebalanceReward",
    );
    assert.equal(rebalance.notionalUsd, "1000.0000");
    assert.equal(rebalance.rewardUsd, "2.5000");
  });

  it("uses same-tx pre-UpdateReserves Pool state for deltas after unrelated same-block reserve changes", async function () {
    let mockDb = MockDb.createMockDb();
    mockDb = await seedRebalanceablePool(mockDb, {
      rebalanceReward: 999,
      reserves0: 100_000n * 10n ** 18n,
      reserves1: 50_000n * 10n ** 18n,
    });

    // The old blockNumber - 1 fallback still sees the previous block's
    // reserves. The rebalance delta must instead start from the Pool state
    // just before the first UpdateReserves in the rebalance tx.
    _setMockReserves(CHAIN_CELO, POOL, {
      reserve0: 100_000n * 10n ** 18n,
      reserve1: 50_000n * 10n ** 18n,
    });
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, 25);

    const unrelatedTx = `0x${"11".repeat(32)}`;
    const rebalanceTx = `0x${"22".repeat(32)}`;

    const unrelatedUpdate = FPMM.UpdateReserves.createMockEvent({
      reserve0: 100_500n * 10n ** 18n,
      reserve1: 49_800n * 10n ** 18n,
      blockTimestamp: 1_700_010_000n,
      mockEventData: rebalancedEventData(605, 7, unrelatedTx),
    });

    const rebalanceFirstUpdate = FPMM.UpdateReserves.createMockEvent({
      reserve0: 100_900n * 10n ** 18n,
      reserve1: 49_550n * 10n ** 18n,
      blockTimestamp: 1_700_010_000n,
      mockEventData: rebalancedEventData(605, 9, rebalanceTx),
    });

    const rebalanceSecondUpdate = FPMM.UpdateReserves.createMockEvent({
      reserve0: 101_000n * 10n ** 18n,
      reserve1: 49_500n * 10n ** 18n,
      blockTimestamp: 1_700_010_000n,
      mockEventData: rebalancedEventData(605, 10, rebalanceTx),
    });

    const event = FPMM.Rebalanced.createMockEvent({
      sender: STRATEGY,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
      mockEventData: rebalancedEventData(605, 11, rebalanceTx),
    });
    mockDb = await processEventsInOneBatch(mockDb, [
      unrelatedUpdate,
      rebalanceFirstUpdate,
      rebalanceSecondUpdate,
      event,
    ]);

    const rebalance = mockDb.entities.RebalanceEvent.get(
      `${CHAIN_CELO}_605_11`,
    ) as
      | {
          amount0Delta: bigint;
          amount1Delta: bigint;
          notionalUsd: string;
          rewardUsd: string;
        }
      | undefined;
    assert.ok(rebalance, "RebalanceEvent must be persisted");
    assert.equal(rebalance.amount0Delta, 500n * 10n ** 18n);
    assert.equal(rebalance.amount1Delta, -300n * 10n ** 18n);
    assert.equal(rebalance.notionalUsd, "500.0000");
    assert.equal(rebalance.rewardUsd, "1.2500");
  });

  it("short-circuits the incentive RPC when Pool.rebalanceReward = -2 sentinel", async function () {
    let mockDb = MockDb.createMockDb();
    mockDb = await seedRebalanceablePool(mockDb, {
      rebalanceReward: -2, // getter missing on this contract
      reserves0: 101_000n * 10n ** 18n,
      reserves1: 49_500n * 10n ** 18n,
    });
    _setMockReserves(CHAIN_CELO, POOL, {
      reserve0: 100_000n * 10n ** 18n,
      reserve1: 50_000n * 10n ** 18n,
    });
    // If the handler did call the RPC, this mock would override to a non-zero
    // value. The assertion below proves the call was skipped.
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, 999);

    const event = FPMM.Rebalanced.createMockEvent({
      sender: STRATEGY,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
      mockEventData: rebalancedEventData(602, 5),
    });
    mockDb = await FPMM.Rebalanced.processEvent({ event, mockDb });

    const rebalance = mockDb.entities.RebalanceEvent.get(
      `${CHAIN_CELO}_602_5`,
    ) as { rewardBps: number; rewardUsd: string; notionalUsd: string };
    assert.equal(
      rebalance.rewardBps,
      0,
      "-2 sentinel must normalize to 0, not the RPC mock value",
    );
    assert.equal(rebalance.rewardUsd, "0.0000");
    assert.equal(rebalance.notionalUsd, "1000.0000");
  });

  it("stamps rewardUsd = '' when block-scoped incentive RPC fails (preserves notional, no fallback)", async function () {
    let mockDb = MockDb.createMockDb();
    mockDb = await seedRebalanceablePool(mockDb, {
      rebalanceReward: 50, // NOT -2 — handler will attempt the RPC
      reserves0: 101_000n * 10n ** 18n,
      reserves1: 49_500n * 10n ** 18n,
    });
    _setMockReserves(CHAIN_CELO, POOL, {
      reserve0: 100_000n * 10n ** 18n,
      reserve1: 50_000n * 10n ** 18n,
    });
    // Simulate block-scoped RPC failure → null. We must NOT (a) fall back to
    // Pool.rebalanceReward (`latest`-seeded by upsertPool's self-heal) nor
    // (b) coerce to 0 (would render as "$0.00", indistinguishable from a
    // real zero-incentive rebalance). Instead, stamp "" so the UI shows "—".
    // Notional is reserves-derived and stays valid.
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, null);

    const event = FPMM.Rebalanced.createMockEvent({
      sender: STRATEGY,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
      mockEventData: rebalancedEventData(603, 5),
    });
    mockDb = await FPMM.Rebalanced.processEvent({ event, mockDb });

    const rebalance = mockDb.entities.RebalanceEvent.get(
      `${CHAIN_CELO}_603_5`,
    ) as { rewardBps: number; rewardUsd: string; notionalUsd: string };
    assert.equal(
      rebalance.rewardBps,
      0,
      "RPC failure must NOT fall back to potentially-stale Pool.rebalanceReward",
    );
    assert.equal(
      rebalance.rewardUsd,
      "",
      "RPC failure must produce '' sentinel (unknown), not '0.0000' (real zero)",
    );
    assert.equal(
      rebalance.notionalUsd,
      "1000.0000",
      "Notional is reserves-derived and stays valid even when incentive RPC fails",
    );
  });

  it("zero deltas (RPC fallback for pre-reserves) → '' sentinel for both USD fields", async function () {
    let mockDb = MockDb.createMockDb();
    mockDb = await seedRebalanceablePool(mockDb, {
      rebalanceReward: 25,
      reserves0: 100_000n * 10n ** 18n,
      reserves1: 50_000n * 10n ** 18n,
    });
    // Simulate fetchReserves(blockNumber - 1) failure → null.
    _setMockReserves(CHAIN_CELO, POOL, null);
    _setMockRebalanceIncentiveAtBlock(CHAIN_CELO, POOL, 25);

    const event = FPMM.Rebalanced.createMockEvent({
      sender: STRATEGY,
      priceDifferenceBefore: 50n,
      priceDifferenceAfter: 5n,
      mockEventData: rebalancedEventData(604, 5),
    });
    mockDb = await FPMM.Rebalanced.processEvent({ event, mockDb });

    const rebalance = mockDb.entities.RebalanceEvent.get(
      `${CHAIN_CELO}_604_5`,
    ) as {
      amount0Delta: bigint;
      amount1Delta: bigint;
      notionalUsd: string;
      rewardUsd: string;
    };
    assert.equal(rebalance.amount0Delta, 0n);
    assert.equal(rebalance.amount1Delta, 0n);
    assert.equal(rebalance.notionalUsd, "");
    assert.equal(rebalance.rewardUsd, "");
  });
});
