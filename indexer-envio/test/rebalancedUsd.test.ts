/// <reference types="mocha" />
import assert from "node:assert/strict";
import generated from "generated";
import { makePoolId } from "../src/helpers.ts";
import {
  _setMockReserves,
  _clearMockReserves,
  _clearMockRebalancingStates,
  _setMockRebalanceIncentiveAtBlock,
  _clearMockRebalanceIncentivesAtBlock,
  _setMockRebalanceThresholds,
  _clearMockRebalanceThresholds,
} from "../src/rpc.ts";

type MockDb = {
  entities: {
    Pool: {
      get: (id: string) => unknown;
      set: (e: unknown) => MockDb;
    };
    RebalanceEvent: { get: (id: string) => unknown };
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
  transaction?: { hash?: string; from?: string };
};

type RebalancedArgs = {
  sender: string;
  priceDifferenceBefore: bigint;
  priceDifferenceAfter: bigint;
  mockEventData: MockEventData;
};

type DeployedArgs = {
  token0: string;
  token1: string;
  fpmmProxy: string;
  fpmmImplementation: string;
  mockEventData: MockEventData;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    FPMMFactory: { FPMMDeployed: EventProcessor<DeployedArgs> };
    FPMM: { Rebalanced: EventProcessor<RebalancedArgs> };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

// Real Celo mainnet addresses — resolvable via KNOWN_TOKEN_META so
// computeRebalanceUsd's symbol lookup succeeds.
const CHAIN_CELO = 42220;
const POOL = "0x00000000000000000000000000000000000000aa";
const FACTORY = "0x00000000000000000000000000000000000000cc";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a"; // 18dp, pegged
const CELO = "0x471ece3750da237f93b8e339c536989b8978a438"; // 18dp, NOT pegged
const STRATEGY = "0x0000000000000000000000000000000000000099";
const TX_FROM = "0x000000000000000000000000000000000000ca11";

function rebalancedEventData(blockNumber: number, logIndex = 5): MockEventData {
  return {
    chainId: CHAIN_CELO,
    logIndex,
    srcAddress: POOL,
    block: { number: blockNumber, timestamp: 1_700_010_000 },
    transaction: { hash: `0x${"ab".repeat(32)}`, from: TX_FROM },
  };
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
  const deploy = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: options.token0 ?? USDM,
    token1: options.token1 ?? CELO,
    fpmmProxy: POOL,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId: CHAIN_CELO,
      logIndex: 0,
      srcAddress: FACTORY,
      block: { number: 100, timestamp: 1_700_000_000 },
    },
  });
  mockDb = await FPMMFactory.FPMMDeployed.processEvent({
    event: deploy,
    mockDb,
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

  after(() => {
    _clearMockReserves();
    _clearMockRebalancingStates();
    _clearMockRebalanceIncentivesAtBlock();
    _clearMockRebalanceThresholds();
  });

  it("stamps amount deltas + USD fields from block-scoped incentive read", async function () {
    this.timeout(10_000);
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

  it("short-circuits the incentive RPC when Pool.rebalanceReward = -2 sentinel", async function () {
    this.timeout(10_000);
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
    this.timeout(10_000);
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
    this.timeout(10_000);
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
