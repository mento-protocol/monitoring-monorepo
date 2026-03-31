/// <reference types="mocha" />
/**
 * Dynamic Contract Registration — Behavioral Documentation
 *
 * This file documents the testing strategy (and limitations) for the
 * contractRegister callbacks in fpmm.ts and virtualPool.ts.
 *
 * The core behavioral change in this PR:
 *   Before: FPMM/VirtualPool addresses were hardcoded in config YAML.
 *   After:  Addresses are registered dynamically via contractRegister hooks
 *           triggered by FPMMFactory.FPMMDeployed and
 *           VirtualPoolFactory.VirtualPoolDeployed events.
 *
 * WHY contractRegister CALLBACKS CANNOT BE UNIT TESTED:
 *   Envio's TestHelpers.processEvent() only exercises the .handler() path.
 *   The .contractRegister() callback is a framework-level hook that Envio
 *   invokes before the handler during real indexing. The test harness does
 *   not expose a processContractRegister() equivalent — this is a framework
 *   limitation, not an oversight.
 *
 * WHAT IS TESTED:
 *   - FPMMDeployed.handler creates a Pool entity (swap-reserves.test.ts)
 *   - VirtualPoolDeployed.handler creates a Pool entity (swap-reserves.test.ts)
 *   - The startup start-block guard (startBlockInvariant.test.ts)
 *
 * WHAT IS VERIFIED BY INSPECTION:
 *   fpmm.ts: FPMMFactory.FPMMDeployed.contractRegister calls
 *     context.addFPMM(event.params.fpmmProxy) — the correct Envio API for
 *     dynamic registration. This is the same API used for ERC20FeeToken
 *     (context.addERC20FeeToken) which was already present and working.
 *
 *   virtualPool.ts: VirtualPoolFactory.VirtualPoolDeployed.contractRegister
 *     calls context.addVirtualPool(event.params.pool) — correct Envio API.
 *
 * INTEGRATION EVIDENCE:
 *   On-chain verification (2026-03-30): EURm/USDm pool on Celo mainnet
 *   (0x1ad2ea06...) had 123 real Swap events but 0 in the indexer because
 *   it was missing from the hardcoded config list. After deploying this fix,
 *   a full reindex will capture all events for all factory-deployed pools.
 */
import { strict as assert } from "assert";
import generated from "generated";

// The `generated` module ships as CommonJS with its own hand-rolled type
// definitions in generated/index.d.ts. It does not export clean standalone
// interface types for MockDb or EventProcessor — only the full namespace shape.
// Importing and narrowing inline avoids duplicating the entire generated
// module's type surface while still giving TS enough to catch call-site errors.
// If generated/index.d.ts gains proper exports in a future Envio version,
// replace these local types with direct imports.
type MockDb = {
  entities: {
    Pool: { get: (id: string) => unknown };
    FactoryDeployment: { get: (id: string) => unknown };
  };
};

type EventProcessor = {
  createMockEvent: (args: unknown) => unknown;
  processEvent: (args: { event: unknown; mockDb: MockDb }) => Promise<MockDb>;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    FPMMFactory: { FPMMDeployed: EventProcessor };
    VirtualPoolFactory: { VirtualPoolDeployed: EventProcessor };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, FPMMFactory, VirtualPoolFactory } = TestHelpers;

const POOL_ADDR = "0x1ad2ea06502919f935d9c09028df73a462979e29";
const VPOOL_ADDR = "0xab945882018b81bdf62629e98ffdafd9495a0076";
const TOKEN0 = "0x765de816845861e75a25fca122bb6898b8b1282a";
const TOKEN1 = "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73";

describe("Dynamic contract registration — handler coverage", () => {
  it("FPMMDeployed.handler creates a Pool entity for the deployed pool", async () => {
    // This tests the .handler() path. The .contractRegister() path
    // (context.addFPMM) cannot be tested via this harness — see file header.
    let mockDb = MockDb.createMockDb();
    const event = FPMMFactory.FPMMDeployed.createMockEvent({
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
    mockDb = await FPMMFactory.FPMMDeployed.processEvent({ event, mockDb });
    const poolId = `42220-${POOL_ADDR}`;
    const pool = mockDb.entities.Pool.get(poolId);
    assert.ok(
      pool,
      `Pool entity must exist after FPMMDeployed (id: ${poolId})`,
    );
  });

  it("VirtualPoolDeployed.handler creates a Pool entity for the deployed pool", async () => {
    let mockDb = MockDb.createMockDb();
    const event = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
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
    mockDb = await VirtualPoolFactory.VirtualPoolDeployed.processEvent({
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
