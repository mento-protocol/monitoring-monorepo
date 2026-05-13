/**
 * Dynamic Contract Registration
 *
 * Tests for the contractRegister hooks that auto-discover new pools from
 * factory deploy events, replacing the old hardcoded address list approach.
 *
 * Two complementary test strategies:
 *
 * 1. REGISTRATION EFFECTS
 *    Drive factory deploy events through createTestIndexer and assert the
 *    dynamic address registrations emitted in the block changes. If fpmm.ts or
 *    virtualPool.ts stops calling .contractRegister(...), these tests fail.
 *
 * 2. HANDLER SMOKE TESTS (existing)
 *    TestHelpers.processEvent() exercises .handler() — proves the handler
 *    creates DB entities correctly. Does NOT test .contractRegister() path
 *    (Envio test harness limitation — no processContractRegister() equivalent).
 */
import { strict as assert } from "assert";
import { createTestIndexer } from "envio";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
} from "./helpers/indexerTestHarness.js";
import {
  setHttpRpcErrorMock,
  waitForHttpTestRpc,
} from "../src/rpc/http-test-mocks.js";

// Import EventHandlers to trigger handler registrations (side-effect import).
// This causes fpmm.ts / virtualPool.ts to call their .contractRegister() and
// .handler() setup — which is what the registration-effect tests below verify.
import {
  _setMockFees,
  _setMockRateFeedID,
  _setMockRebalanceThresholds,
  _setMockTokenDecimalsScaling,
  _setMockVpExchangeId,
} from "../src/EventHandlers.ts";
import { VP_PROBE_RPC_ERROR } from "../src/rpc/biPoolManager.js";

type MockDb = MockDbWith<{
  Pool: EntityReader;
  FactoryDeployment: EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const {
  MockDb,
  FPMMFactory: TestFPMMFactory,
  VirtualPoolFactory: TestVirtualPoolFactory,
} = TestHelpers;

type AddressRegistration = {
  contract: string;
  address: string;
};

async function processDeployRegistration(
  contract: "FPMMFactory" | "VirtualPoolFactory",
  event: "FPMMDeployed" | "VirtualPoolDeployed",
  params: Record<string, unknown>,
): Promise<AddressRegistration[]> {
  seedDeployRpcMocks(contract, params);
  await waitForHttpTestRpc();
  const indexer = createTestIndexer();
  const result = await indexer.process({
    chains: {
      [CHAIN_ID]: {
        startBlock: 1,
        endBlock: 1,
        simulate: [
          {
            contract,
            event,
            srcAddress: "0x00000000000000000000000000000000000000cc",
            logIndex: 0,
            block: { number: 1, timestamp: 1_700_000_000 },
            transaction: {
              hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
              from: "0x0000000000000000000000000000000000000000",
              to: "0x00000000000000000000000000000000000000cc",
            },
            params,
          },
        ],
      },
    },
  });
  return result.changes.flatMap((change) => [
    ...((change.addresses?.sets ?? []) as AddressRegistration[]),
  ]);
}

function seedDeployRpcMocks(
  contract: "FPMMFactory" | "VirtualPoolFactory",
  params: Record<string, unknown>,
): void {
  const tokenDecimalsScaling = 10n ** 18n;
  if (contract === "FPMMFactory") {
    const pool = String(params.fpmmProxy);
    _setMockRateFeedID(CHAIN_ID, pool, null);
    _setMockRebalanceThresholds(CHAIN_ID, pool, { above: 100, below: 100 });
    _setMockTokenDecimalsScaling(
      CHAIN_ID,
      pool,
      "decimals0",
      tokenDecimalsScaling,
    );
    _setMockTokenDecimalsScaling(
      CHAIN_ID,
      pool,
      "decimals1",
      tokenDecimalsScaling,
    );
    _setMockFees(CHAIN_ID, pool, {
      lpFee: { fulfilled: 0n },
      protocolFee: { fulfilled: 0n },
      rebalanceReward: { fulfilled: 0n },
    });
    setHttpRpcErrorMock({
      group: "dynamicRegistration",
      chainId: CHAIN_ID,
      address: pool,
      functionName: "invertRateFeed",
    });
    return;
  }

  const pool = String(params.pool);
  _setMockTokenDecimalsScaling(
    CHAIN_ID,
    pool,
    "decimals0",
    tokenDecimalsScaling,
  );
  _setMockTokenDecimalsScaling(
    CHAIN_ID,
    pool,
    "decimals1",
    tokenDecimalsScaling,
  );
  _setMockVpExchangeId(CHAIN_ID, pool, VP_PROBE_RPC_ERROR);
}

describe("Dynamic contract registration — registration effects", () => {
  it("FPMMFactory.FPMMDeployed dynamically registers the deployed FPMM", async () => {
    const registrations = await processDeployRegistration(
      "FPMMFactory",
      "FPMMDeployed",
      {
        fpmmProxy: POOL_ADDR,
        fpmmImplementation: "0x00000000000000000000000000000000000000bc",
        token0: TOKEN0,
        token1: TOKEN1,
      },
    );
    assert.ok(
      registrations.some(
        (entry) =>
          entry.contract === "FPMM" &&
          entry.address.toLowerCase() === POOL_ADDR.toLowerCase(),
      ),
      "FPMMFactory.FPMMDeployed must dynamically register the deployed FPMM address.",
    );
  });

  it("VirtualPoolFactory.VirtualPoolDeployed dynamically registers the deployed VirtualPool", async () => {
    const registrations = await processDeployRegistration(
      "VirtualPoolFactory",
      "VirtualPoolDeployed",
      { pool: VPOOL_ADDR, token0: TOKEN0, token1: TOKEN1 },
    );
    assert.ok(
      registrations.some(
        (entry) =>
          entry.contract === "VirtualPool" &&
          entry.address.toLowerCase() === VPOOL_ADDR.toLowerCase(),
      ),
      "VirtualPoolFactory.VirtualPoolDeployed must dynamically register the deployed VirtualPool address.",
    );
  });
});

const POOL_ADDR = "0x1ad2ea06502919f935d9c09028df73a462979e29";
const VPOOL_ADDR = "0xab945882018b81bdf62629e98ffdafd9495a0076";
const TOKEN0 = "0x765de816845861e75a25fca122bb6898b8b1282a";
const TOKEN1 = "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73";
const CHAIN_ID = 42220;

describe("Dynamic contract registration — handler smoke tests", () => {
  it("FPMMDeployed.handler creates a Pool entity for the deployed pool", async () => {
    // Tests .handler() path only. .contractRegister() path is verified by the
    // registration-effect suite above rather than via
    // TestHelpers.processEvent, which does not exercise contractRegister.
    let mockDb = MockDb.createMockDb();
    const event = TestFPMMFactory.FPMMDeployed.createMockEvent({
      fpmmProxy: POOL_ADDR,
      fpmmImplementation: "0x00000000000000000000000000000000000000bc",
      token0: TOKEN0,
      token1: TOKEN1,
      mockEventData: {
        chainId: 42220,
        logIndex: 1,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 62725622, timestamp: 1_700_010_000 },
      },
    });
    mockDb = await TestFPMMFactory.FPMMDeployed.processEvent({ event, mockDb });
    const poolId = `42220-${POOL_ADDR}`;
    const pool = mockDb.entities.Pool.get(poolId);
    assert.ok(
      pool,
      `Pool entity must exist after FPMMDeployed (id: ${poolId})`,
    );
  });

  it("VirtualPoolDeployed.handler creates a Pool entity for the deployed pool", async () => {
    let mockDb = MockDb.createMockDb();
    const event = TestVirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
      pool: VPOOL_ADDR,
      token0: TOKEN0,
      token1: TOKEN1,
      mockEventData: {
        chainId: 42220,
        logIndex: 1,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 60668100, timestamp: 1_700_020_000 },
      },
    });
    mockDb = await TestVirtualPoolFactory.VirtualPoolDeployed.processEvent({
      event,
      mockDb,
    });
    const poolId = `42220-${VPOOL_ADDR}`;
    const pool = mockDb.entities.Pool.get(poolId);
    assert.ok(
      pool,
      `Pool entity must exist after VirtualPoolDeployed (id: ${poolId})`,
    );
  });
});
