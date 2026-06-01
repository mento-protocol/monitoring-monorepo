import { createTestIndexer } from "envio";
import type { TestIndexer } from "envio";

import { waitForHttpTestRpc } from "../../src/rpc/http-test-mocks.js";

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
  V2StableToken: ContractTestHelpers<Db>;
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
  V2StableToken: contract("V2StableToken"),
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
