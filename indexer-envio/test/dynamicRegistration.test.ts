/// <reference types="mocha" />
/**
 * Dynamic Contract Registration
 *
 * Tests for the contractRegister hooks that auto-discover new pools from
 * factory deploy events, replacing the old hardcoded address list approach.
 *
 * Two complementary test strategies:
 *
 * 1. REGISTRATION INTROSPECTION (new — will catch removed contractRegister calls)
 *    Read the Envio handler registry directly after importing EventHandlers.
 *    If fpmm.ts stops calling FPMMFactory.FPMMDeployed.contractRegister(...),
 *    EventRegister.getContractRegister(handlerRegister) returns undefined and
 *    these tests fail.
 *
 * 2. HANDLER SMOKE TESTS (existing)
 *    TestHelpers.processEvent() exercises .handler() — proves the handler
 *    creates DB entities correctly. Does NOT test .contractRegister() path
 *    (Envio test harness limitation — no processContractRegister() equivalent).
 */
import { strict as assert } from "assert";
import generated from "generated";

// Import EventHandlers to trigger handler registrations (side-effect import).
// This causes fpmm.ts / virtualPool.ts to call their .contractRegister() and
// .handler() setup — which is what the introspection tests below verify.
import "../src/EventHandlers.ts";

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
const {
  MockDb,
  FPMMFactory: TestFPMMFactory,
  VirtualPoolFactory: TestVirtualPoolFactory,
} = TestHelpers;

// ---------------------------------------------------------------------------
// Registry introspection
//
// Access the Envio handler registry directly to assert that contractRegister
// callbacks are wired up. These tests WILL FAIL if someone removes the
// contractRegister() calls from fpmm.ts or virtualPool.ts.
//
// Envio types.res.js exposes Types.FPMMFactory.FPMMDeployed.handlerRegister
// and EventRegister.getContractRegister(). We use the internal JS modules
// since the TypeScript types don't expose these. If the Envio package changes
// its internal structure, these imports will fail — that's intentional.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const EventRegister = require("envio/src/EventRegister.res.js") as {
  getContractRegister: (reg: unknown) => unknown;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const GeneratedTypes = require("generated/src/Types.res.js") as {
  FPMMFactory: { FPMMDeployed: { handlerRegister: unknown } };
  VirtualPoolFactory: { VirtualPoolDeployed: { handlerRegister: unknown } };
};

describe("Dynamic contract registration — registry introspection", () => {
  it("FPMMFactory.FPMMDeployed has a contractRegister callback registered", () => {
    // This test FAILS if fpmm.ts removes:
    //   FPMMFactory.FPMMDeployed.contractRegister(({ event, context }) => {
    //     context.addFPMM(event.params.fpmmProxy);
    //   })
    const reg = EventRegister.getContractRegister(
      GeneratedTypes.FPMMFactory.FPMMDeployed.handlerRegister,
    );
    assert.ok(
      reg !== undefined && reg !== null,
      "FPMMFactory.FPMMDeployed must have a contractRegister callback. " +
        "If this test fails, check that fpmm.ts calls .contractRegister() " +
        "with context.addFPMM() — removing it silently breaks pool discovery.",
    );
  });

  it("VirtualPoolFactory.VirtualPoolDeployed has a contractRegister callback registered", () => {
    // This test FAILS if virtualPool.ts removes:
    //   VirtualPoolFactory.VirtualPoolDeployed.contractRegister(({ event, context }) => {
    //     context.addVirtualPool(event.params.pool);
    //   })
    const reg = EventRegister.getContractRegister(
      GeneratedTypes.VirtualPoolFactory.VirtualPoolDeployed.handlerRegister,
    );
    assert.ok(
      reg !== undefined && reg !== null,
      "VirtualPoolFactory.VirtualPoolDeployed must have a contractRegister callback. " +
        "If this test fails, check that virtualPool.ts calls .contractRegister() " +
        "with context.addVirtualPool() — removing it silently breaks VirtualPool discovery.",
    );
  });
});

const POOL_ADDR = "0x1ad2ea06502919f935d9c09028df73a462979e29";
const VPOOL_ADDR = "0xab945882018b81bdf62629e98ffdafd9495a0076";
const TOKEN0 = "0x765de816845861e75a25fca122bb6898b8b1282a";
const TOKEN1 = "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73";

describe("Dynamic contract registration — handler smoke tests", () => {
  it("FPMMDeployed.handler creates a Pool entity for the deployed pool", async () => {
    // Tests .handler() path only. .contractRegister() path is verified by the
    // introspection suite above (registry-level assertion) rather than via
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
