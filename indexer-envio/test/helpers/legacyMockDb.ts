import { createTestIndexer } from "envio";
import type { TestIndexer } from "envio";

import { ensureHttpTestRpc } from "../../src/rpc/http-test-mocks.js";

type Entity = { id: string };

type EntityStore = {
  get: (id: string) => unknown;
  getAll: () => unknown[];
  set: (entity: Entity) => LegacyMockDb;
};

export type LegacyMockDb = {
  entities: Record<string, EntityStore>;
  _stores: Map<string, Map<string, Entity>>;
};

type MockEventData = {
  chainId?: number;
  srcAddress?: string;
  logIndex?: number;
  block?: { number?: number | bigint; timestamp?: number | bigint };
  transaction?: Record<string, unknown>;
};

type LegacyEvent = {
  contractName: string;
  eventName: string;
  params: Record<string, unknown>;
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: Record<string, unknown>;
};

function entityStore(db: LegacyMockDb, entityName: string): EntityStore {
  let store = db._stores.get(entityName);
  if (!store) {
    store = new Map<string, Entity>();
    db._stores.set(entityName, store);
  }
  return {
    get: (id: string) => store.get(id),
    getAll: () => Array.from(store.values()),
    set: (entity: Entity) => {
      store.set(entity.id, entity);
      return db;
    },
  };
}

function createMockDb(): LegacyMockDb {
  const db = {
    _stores: new Map<string, Map<string, Entity>>(),
  } as LegacyMockDb;
  db.entities = new Proxy({} as Record<string, EntityStore>, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      target[prop] ??= entityStore(db, prop);
      return target[prop];
    },
  });
  return db;
}

function normalizeEvent(
  contractName: string,
  eventName: string,
  args: Record<string, unknown>,
): LegacyEvent {
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

function seedIndexer(indexer: TestIndexer, db: LegacyMockDb): void {
  const target = indexer as unknown as Record<
    string,
    { set?: (entity: Entity) => void }
  >;
  for (const [entityName, rows] of db._stores) {
    const ops = target[entityName];
    if (!ops?.set) continue;
    for (const entity of rows.values()) {
      ops.set(entity);
    }
  }
}

function applyChanges(db: LegacyMockDb, changes: readonly object[]): void {
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
        | { sets?: Entity[]; deleted?: string[] }
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
      event: LegacyEvent;
      mockDb: LegacyMockDb;
    }): Promise<LegacyMockDb> => {
      ensureHttpTestRpc();
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

function contract<EventName extends string>(
  contractName: string,
  eventNames: readonly EventName[],
): Record<EventName, ReturnType<typeof makeEventProcessor>> {
  return Object.fromEntries(
    eventNames.map((eventName) => [
      eventName,
      makeEventProcessor(contractName, eventName),
    ]),
  ) as Record<EventName, ReturnType<typeof makeEventProcessor>>;
}

export const TestHelpers = {
  MockDb: { createMockDb },
  Broker: contract("Broker", ["Swap"]),
  FPMMFactory: contract("FPMMFactory", ["FPMMDeployed"]),
  FPMM: contract("FPMM", [
    "UpdateReserves",
    "Swap",
    "Mint",
    "Burn",
    "Rebalanced",
    "LPFeeUpdated",
    "ProtocolFeeUpdated",
    "RebalanceIncentiveUpdated",
  ]),
  VirtualPoolFactory: contract("VirtualPoolFactory", ["VirtualPoolDeployed"]),
  VirtualPool: contract("VirtualPool", ["UpdateReserves", "Swap"]),
  BiPoolManager: contract("BiPoolManager", [
    "ExchangeCreated",
    "ExchangeDestroyed",
    "BucketsUpdated",
    "SpreadUpdated",
  ]),
  ERC20FeeToken: contract("ERC20FeeToken", ["Transfer"]),
  BreakerBox: contract("BreakerBox", [
    "BreakerStatusUpdated",
    "BreakerTripped",
    "ResetSuccessful",
    "BreakerRemoved",
    "TradingModeUpdated",
  ]),
  MedianDeltaBreaker: contract("MedianDeltaBreaker", ["MedianRateEMAReset"]),
  SortedOracles: contract("SortedOracles", ["MedianUpdated"]),
  WormholeNttManager: contract("WormholeNttManager", [
    "TransferSentDetailed",
    "TransferSentDigest",
    "TransferRedeemed",
    "MessageAttestedTo",
    "InboundTransferQueued",
  ]),
  WormholeTransceiver: contract("WormholeTransceiver", ["ReceivedMessage"]),
};

TestHelpers.TestWormholeNttManager = TestHelpers.WormholeNttManager;
TestHelpers.TestWormholeTransceiver = TestHelpers.WormholeTransceiver;

export default { TestHelpers };
