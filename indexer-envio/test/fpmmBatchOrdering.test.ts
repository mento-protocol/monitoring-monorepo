import assert from "node:assert/strict";
import {
  indexerTestHelpers,
  processMockEvents,
  type EntityCollection,
  type MockDbWith,
  type MockEventData,
} from "./helpers/indexerTestHarness.js";
import { createMockEventData } from "./helpers/eventFixtures.js";
import { makePoolId } from "../src/helpers.ts";

// ---------------------------------------------------------------------------
// Issue #1053 scenario 4 — a pool created by the factory and swapped within
// the same processing batch: ordering holds (Envio's (block, logIndex)
// ordering governs processing, not array position), and no orphan rows
// appear (the Swap must attach to the pool the factory created, not spawn
// a second default Pool via `getOrCreatePool`'s fallback).
//
// `events` is submitted to `processMockEvents` with the Swap listed BEFORE
// the FPMMDeployed event in the array on purpose — proving the assertions
// below hold because of Envio's block/logIndex ordering, not because the
// test happened to list events in processing order.
// ---------------------------------------------------------------------------

type MockDb = MockDbWith<{
  Pool: EntityCollection;
  FactoryDeployment: EntityCollection;
  SwapEvent: EntityCollection;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

const CHAIN_ID = 42220;
const FACTORY_ADDRESS = "0x00000000000000000000000000000000000000cc";
const POOL_ADDRESS = "0x00000000000000000000000000000000000000fa";
const TOKEN0 = "0x0000000000000000000000000000000000000003";
const TOKEN1 = "0x0000000000000000000000000000000000000004";
const IMPLEMENTATION = "0x00000000000000000000000000000000000000bc";
// Deploy and Swap land in DIFFERENT blocks of the same batch on purpose
// (a real deploy-then-swap sequence spans blocks). This makes `createdAtBlock`
// an order-sensitive witness: `upsertPool` stamps it on first touch and
// preserves it afterward, so if Envio processed the Swap before the Deploy
// (array order, not (block, logIndex) order), `createdAtBlock` would read
// the SWAP's block instead of the DEPLOY's — a fact that stays otherwise
// invisible in token0/token1/swapCount, which converge to the same value
// regardless of processing order (see the codex finding this fixed).
const DEPLOY_BLOCK = 5_000;
const SWAP_BLOCK = 5_001;
const BLOCK_TIMESTAMP = 1_700_500_000;

function mockEventData(
  logIndex: number,
  srcAddress: string,
  blockNumber: number,
): MockEventData {
  return createMockEventData({
    chainId: CHAIN_ID,
    logIndex,
    srcAddress,
    blockNumber,
    blockTimestamp: BLOCK_TIMESTAMP + (blockNumber - DEPLOY_BLOCK),
  });
}

describe("pool created + swapped in the same batch (issue #1053 scenario 4)", () => {
  it("Swap attaches to the factory-created pool; no orphan Pool/SwapEvent rows appear", async () => {
    const mockDb = MockDb.createMockDb();

    const swapEvent = FPMM.Swap.createMockEvent({
      sender: TOKEN0,
      to: TOKEN1,
      amount0In: 1_000_000_000_000_000_000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 2_000_000_000_000_000_000n,
      mockEventData: mockEventData(0, POOL_ADDRESS, SWAP_BLOCK),
    });
    const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
      token0: TOKEN0,
      token1: TOKEN1,
      fpmmProxy: POOL_ADDRESS,
      fpmmImplementation: IMPLEMENTATION,
      mockEventData: mockEventData(0, FACTORY_ADDRESS, DEPLOY_BLOCK),
    });

    // Deliberately listed Swap-before-Deploy: processing order must still
    // follow (block, logIndex), not array position.
    await processMockEvents({ mockDb, events: [swapEvent, deployEvent] });

    const poolId = makePoolId(CHAIN_ID, POOL_ADDRESS);
    const pools = mockDb.entities.Pool.getAll();
    assert.equal(pools.length, 1, "exactly one Pool row — no orphan default");
    const pool = pools[0] as {
      id: string;
      token0?: string;
      token1?: string;
      swapCount: number;
      source: string;
      createdAtBlock: bigint;
    };
    assert.equal(pool.id, poolId);
    assert.equal(pool.token0, TOKEN0);
    assert.equal(pool.token1, TOKEN1);
    assert.equal(pool.swapCount, 1);
    // Order-sensitive witness: `upsertPool` stamps `createdAtBlock` on first
    // touch only. If the Swap had actually been processed before the
    // Deploy (array order, not (block, logIndex) order), this would read
    // SWAP_BLOCK instead — token0/token1/swapCount alone can't detect that
    // regression because they converge to the same value either way.
    assert.equal(
      pool.createdAtBlock,
      BigInt(DEPLOY_BLOCK),
      "createdAtBlock must be stamped by the deploy (the true first event), not by an out-of-order Swap",
    );

    const deployments = mockDb.entities.FactoryDeployment.getAll();
    assert.equal(deployments.length, 1);
    assert.equal((deployments[0] as { poolId: string }).poolId, poolId);

    const swaps = mockDb.entities.SwapEvent.getAll();
    assert.equal(swaps.length, 1, "exactly one SwapEvent row — no orphan");
    assert.equal((swaps[0] as { poolId: string }).poolId, poolId);
  });
});
