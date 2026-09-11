import { createTestIndexer } from "envio";
import type { TestIndexer } from "envio";
// envio publishes no `exports` map, so its config singleton is importable. The
// harness edits it to route synthetic test addresses (see `envioConfig`).
// @ts-expect-error -- ReScript output ships no type declarations.
import * as EnvioConfig from "envio/src/Config.res.mjs";
// @ts-expect-error -- ReScript output ships no type declarations.
import * as EnvioChainMap from "envio/src/ChainMap.res.mjs";

import { waitForHttpTestRpc } from "../../src/rpc/http-test-mocks.js";
// Register every handler once, through vitest's module graph, so `vi.mock` and
// the shared RPC test mocks apply to them. See `envioConfig` below.
import "../../src/EventHandlers.js";

// Thin Envio v3 test harness that preserves the concise MockDb-style
// entity assertions used by multi-event integration tests.
export type MockEntity = { id: string };

export type EntityStore<T extends MockEntity = MockEntity, Db = MockDb> = {
  get: (id: string) => T | undefined;
  getAll: () => T[];
  set: (entity: T) => Db;
};

export type MockDb = {
  entities: Record<string, EntityStore<MockEntity, MockDb>>;
  _stores: Map<string, Map<string, MockEntity>>;
};

export type EntityReader<T = unknown> = {
  get: (id: string) => T | undefined;
};

export type EntityCollection<T = unknown> = EntityReader<T> & {
  getAll: () => T[];
};

export type WritableEntity<T = unknown, Db = MockDb> = EntityReader<T> & {
  set: (entity: T) => Db;
};

export type MockDbWith<Entities extends Record<string, object>> = MockDb & {
  entities: MockDb["entities"] & Entities;
};

export type MockEventData = {
  chainId?: number;
  srcAddress?: string;
  logIndex?: number;
  block?: { number?: number | bigint; timestamp?: number | bigint };
  transaction?: Record<string, unknown>;
};

type MockEvent = {
  contractName: string;
  eventName: string;
  params: Record<string, unknown>;
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: Record<string, unknown>;
};

export type EventProcessor<Args = unknown, Db extends MockDb = MockDb> = {
  createMockEvent: (args: Args) => unknown;
  processEvent: (args: { event: unknown; mockDb: Db }) => Promise<Db>;
};

/** Every event on a contract resolves to an `EventProcessor`. Event names are
 * intentionally NOT hand-listed: the runtime builds each one on demand (see
 * `contract`) and `processEvent` dispatches to whatever handler the indexer
 * registered for `(contract, event)`. So a newly-handled event is reachable
 * from tests with no edit to this file. */
export type ContractTestHelpers<Db extends MockDb = MockDb> = Record<
  string,
  EventProcessor<unknown, Db>
>;

/** Contracts are listed explicitly (they change rarely and the names aid
 * autocomplete); their events are open (see `ContractTestHelpers`). */
export type IndexerTestHelpers<Db extends MockDb = MockDb> = {
  MockDb: { createMockDb: () => Db };
  Broker: ContractTestHelpers<Db>;
  FPMMFactory: ContractTestHelpers<Db>;
  FPMM: ContractTestHelpers<Db>;
  VirtualPoolFactory: ContractTestHelpers<Db>;
  VirtualPool: ContractTestHelpers<Db>;
  BiPoolManager: ContractTestHelpers<Db>;
  ERC20FeeToken: ContractTestHelpers<Db>;
  StableToken: ContractTestHelpers<Db>;
  Susds: ContractTestHelpers<Db>;
  Steth: ContractTestHelpers<Db>;
  LiquityTroveManager: ContractTestHelpers<Db>;
  LiquityStabilityPool: ContractTestHelpers<Db>;
  BreakerBox: ContractTestHelpers<Db>;
  MedianDeltaBreaker: ContractTestHelpers<Db>;
  SortedOracles: ContractTestHelpers<Db>;
  WormholeNttManager: ContractTestHelpers<Db>;
  WormholeTransceiver: ContractTestHelpers<Db>;
  TestWormholeNttManager: ContractTestHelpers<Db>;
  TestWormholeTransceiver: ContractTestHelpers<Db>;
};

function entityStore(
  db: MockDb,
  entityName: string,
): EntityStore<MockEntity, MockDb> {
  let store = db._stores.get(entityName);
  if (!store) {
    store = new Map<string, MockEntity>();
    db._stores.set(entityName, store);
  }
  return {
    get: (id: string) => store.get(id),
    getAll: () => Array.from(store.values()),
    set: (entity: MockEntity) => {
      store.set(entity.id, entity);
      return db;
    },
  };
}

function createMockDb(): MockDb {
  const db = {
    _stores: new Map<string, Map<string, MockEntity>>(),
  } as MockDb;
  db.entities = new Proxy(
    {} as Record<string, EntityStore<MockEntity, MockDb>>,
    {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        target[prop] ??= entityStore(db, prop);
        return target[prop];
      },
    },
  );
  return db;
}

function normalizeEvent(
  contractName: string,
  eventName: string,
  args: Record<string, unknown>,
): MockEvent {
  const { mockEventData, ...params } = args as Record<string, unknown> & {
    mockEventData?: MockEventData;
  };
  const data = mockEventData ?? {};
  const blockNumber = Number(data.block?.number ?? 1);
  const blockTimestamp = Number(data.block?.timestamp ?? 1);
  return {
    contractName,
    eventName,
    params,
    chainId: Number(data.chainId ?? 42220),
    srcAddress: data.srcAddress ?? "0x0000000000000000000000000000000000000000",
    logIndex: Number(data.logIndex ?? 0),
    block: { number: blockNumber, timestamp: blockTimestamp },
    transaction: {
      hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      from: "0x0000000000000000000000000000000000000000",
      to: null,
      ...data.transaction,
    },
  };
}

type EnvioContractConfig = { name: string; addresses: string[] };
type EnvioChainConfig = { id: number; contracts: EnvioContractConfig[] };

// envio's cached config singleton, which `createTestIndexer()` reads on every
// call. Two edits keep the handler tests working on envio >= 3.9:
// 1. `contractHandlers = []` stops `registerAllHandlers` from natively
//    importing `src/EventHandlers.ts` a second time. vitest already evaluated
//    it (import above); a second module instance would register every handler
//    twice and run every event twice. `src/handlers` auto-loading is disabled
//    in config.yaml (`handlers:` points at an empty directory), and
//    test/handlerRegistrationNative.test.ts guards the production loader path.
// 2. `registerSimulateAddresses` adds simulated `(chain, contract, srcAddress)`
//    triples to the contract address lists the test indexer seeds its routing
//    table from. envio >= 3.9 drops simulated events from unregistered
//    addresses; handler tests use synthetic addresses with directly seeded
//    entities, so this restores the 3.x "route everything" behaviour.
const envioConfig = EnvioConfig.load() as {
  chainMap: unknown;
  contractHandlers: unknown[];
};
envioConfig.contractHandlers = [];
const envioChains = EnvioChainMap.values(
  envioConfig.chainMap,
) as EnvioChainConfig[];

export type SimulateSource = {
  chainId: number;
  contractName: string;
  srcAddress: string;
};

/** Register simulated sources before `createTestIndexer()`. Tests that call
 * `indexer.process()` directly must call this for every
 * `(chain, contract, srcAddress)` they simulate; `processEvent` and
 * `processMockEvents` do it for their callers. */
export function registerSimulateAddresses(
  sources: readonly SimulateSource[],
): void {
  for (const source of sources) {
    const chain = envioChains.find((c) => c.id === source.chainId);
    if (!chain) {
      throw new Error(
        `registerSimulateAddresses: chain ${source.chainId} is not in config.yaml`,
      );
    }
    const contract = chain.contracts.find(
      (c) => c.name === source.contractName,
    );
    if (!contract) {
      throw new Error(
        `registerSimulateAddresses: contract ${source.contractName} is not configured on chain ${source.chainId}`,
      );
    }
    const address = EnvioConfig.normalizeSimulateAddress(
      envioConfig,
      source.srcAddress,
    ) as string;
    if (!contract.addresses.includes(address)) {
      contract.addresses.push(address);
    }
  }
}

function seedIndexer(indexer: TestIndexer, db: MockDb): void {
  const target = indexer as unknown as Record<
    string,
    { set?: (entity: MockEntity) => void }
  >;
  for (const [entityName, rows] of db._stores) {
    const ops = target[entityName];
    if (!ops?.set) continue;
    for (const entity of rows.values()) {
      ops.set(entity);
    }
  }
}

function applyChanges(db: MockDb, changes: readonly object[]): void {
  for (const change of changes as Array<Record<string, unknown>>) {
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
      const store = db.entities[entityName];
      for (const entity of entityChange.sets ?? []) {
        store.set(entity);
      }
      for (const id of entityChange.deleted ?? []) {
        db._stores.get(entityName)?.delete(id);
      }
    }
  }
}

function makeEventProcessor(contractName: string, eventName: string) {
  return {
    createMockEvent: (args: Record<string, unknown>) =>
      normalizeEvent(contractName, eventName, args),
    processEvent: async ({
      event,
      mockDb,
    }: {
      event: MockEvent;
      mockDb: MockDb;
    }): Promise<MockDb> => {
      await waitForHttpTestRpc();
      registerSimulateAddresses([event]);
      const indexer = createTestIndexer();
      seedIndexer(indexer, mockDb);
      const block = Number(event.block.number);
      const result = await indexer.process({
        chains: {
          [event.chainId]: {
            startBlock: block,
            endBlock: block,
            simulate: [
              {
                contract: event.contractName,
                event: event.eventName,
                srcAddress: event.srcAddress,
                logIndex: event.logIndex,
                block: event.block,
                transaction: event.transaction,
                params: event.params,
              },
            ],
          },
        },
      });
      applyChanges(mockDb, result.changes);
      return mockDb;
    },
  };
}

export async function processMockEvents<Db extends MockDb>({
  events,
  mockDb,
}: {
  events: unknown[];
  mockDb: Db;
}): Promise<Db> {
  if (events.length === 0) return mockDb;
  await waitForHttpTestRpc();
  const mockEvents = events as MockEvent[];
  registerSimulateAddresses(mockEvents);
  const indexer = createTestIndexer();
  seedIndexer(indexer, mockDb);
  const chains: Record<
    number,
    {
      startBlock: number;
      endBlock: number;
      simulate: Array<{
        contract: string;
        event: string;
        srcAddress: string;
        logIndex: number;
        block: { number: number; timestamp: number };
        transaction: Record<string, unknown>;
        params: Record<string, unknown>;
      }>;
    }
  > = {};
  for (const event of mockEvents) {
    const block = Number(event.block.number);
    const chain = (chains[event.chainId] ??= {
      startBlock: block,
      endBlock: block,
      simulate: [],
    });
    chain.startBlock = Math.min(chain.startBlock, block);
    chain.endBlock = Math.max(chain.endBlock, block);
    chain.simulate.push({
      contract: event.contractName,
      event: event.eventName,
      srcAddress: event.srcAddress,
      logIndex: event.logIndex,
      block: event.block,
      transaction: event.transaction,
      params: event.params,
    });
  }
  const result = await indexer.process({ chains });
  applyChanges(mockDb, result.changes);
  return mockDb;
}

/** Build a contract's event helpers lazily: any accessed event name resolves to
 * a cached `makeEventProcessor`. Event names are NOT enumerated here —
 * `processEvent` dispatches to whatever handler the indexer registered for
 * `(contractName, eventName)`, so adding a handler makes its event reachable
 * automatically. (The footgun this replaces: a hand-listed array silently
 * omitting a new event surfaced as `undefined.processEvent` at run time.) */
function contract(
  contractName: string,
): Record<string, ReturnType<typeof makeEventProcessor>> {
  const cache: Record<string, ReturnType<typeof makeEventProcessor>> = {};
  return new Proxy(cache, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      target[prop] ??= makeEventProcessor(contractName, prop);
      return target[prop];
    },
  });
}

// Contracts are listed; their events are resolved on demand by `contract`'s
// Proxy from the indexer's registered handlers — no per-event maintenance.
export const TestHelpers = {
  MockDb: { createMockDb },
  Broker: contract("Broker"),
  FPMMFactory: contract("FPMMFactory"),
  FPMM: contract("FPMM"),
  VirtualPoolFactory: contract("VirtualPoolFactory"),
  VirtualPool: contract("VirtualPool"),
  BiPoolManager: contract("BiPoolManager"),
  ERC20FeeToken: contract("ERC20FeeToken"),
  StableToken: contract("StableToken"),
  Susds: contract("Susds"),
  Steth: contract("Steth"),
  LiquityTroveManager: contract("LiquityTroveManager"),
  LiquityStabilityPool: contract("LiquityStabilityPool"),
  BreakerBox: contract("BreakerBox"),
  MedianDeltaBreaker: contract("MedianDeltaBreaker"),
  SortedOracles: contract("SortedOracles"),
  WormholeNttManager: contract("WormholeNttManager"),
  WormholeTransceiver: contract("WormholeTransceiver"),
};

TestHelpers.TestWormholeNttManager = TestHelpers.WormholeNttManager;
TestHelpers.TestWormholeTransceiver = TestHelpers.WormholeTransceiver;

export function indexerTestHelpers<
  Db extends MockDb = MockDb,
>(): IndexerTestHelpers<Db> {
  return TestHelpers as unknown as IndexerTestHelpers<Db>;
}

export default { TestHelpers };
