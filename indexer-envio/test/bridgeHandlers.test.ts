/// <reference types="mocha" />
/**
 * Bridge-flows handler-level tests — exercise the codex-review scenarios
 * that cannot be checked by pure-function tests:
 *
 *   1. Replay idempotency (BridgeDailySnapshot + BridgeBridger don't double)
 *   2. Destination-first race (TransferRedeemed before TransferSent)
 *   3. Multi-send pending pairing (2 TransferSent pairs in one tx)
 *
 * We drive the handlers through Envio's TestHelpers.processEvent against a
 * MockDb, then assert on the resulting entity rows.
 */
import { strict as assert } from "assert";
import generated from "generated";
import { findByNttManager } from "../src/wormhole/nttAddresses";

// Side-effect: register handlers with Envio.
import "../src/EventHandlers.ts";

type EntityGet<T> = { get: (id: string) => T | undefined };
type MockDb = {
  entities: {
    BridgeTransfer: EntityGet<{
      id: string;
      status: string;
      attestationCount: number;
      amount?: bigint;
      sentBlock?: bigint;
      deliveredBlock?: bigint;
      sourceChainId?: number;
      destChainId?: number;
      sender?: string;
      tokenSymbol: string;
    }>;
    WormholeTransferDetail: EntityGet<{
      id: string;
      digest: string;
      msgSequence?: bigint;
      inboundQueuedTimestamp?: bigint;
    }>;
    WormholeNttManager: EntityGet<{ id: string; tokenSymbol: string }>;
    WormholeTransferPending: EntityGet<{ id: string; amount: bigint }>;
    BridgeDailySnapshot: {
      get: (id: string) =>
        | {
            id: string;
            sentCount: number;
            deliveredCount: number;
            sentVolume: bigint;
            deliveredVolume: bigint;
          }
        | undefined;
      getAll: () => Array<{
        id: string;
        sentCount: number;
        deliveredCount: number;
        sentVolume: bigint;
        deliveredVolume: bigint;
      }>;
    };
    BridgeBridger: EntityGet<{
      id: string;
      sender: string;
      totalSentCount: number;
    }>;
    BridgeAttestation: EntityGet<{ id: string; transferId: string }>;
  };
};

type EventProcessor = {
  createMockEvent: (args: unknown) => unknown;
  processEvent: (args: { event: unknown; mockDb: MockDb }) => Promise<MockDb>;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    WormholeNttManager: {
      TransferSentDetailed: EventProcessor;
      TransferSentDigest: EventProcessor;
      TransferRedeemed: EventProcessor;
      MessageAttestedTo: EventProcessor;
      InboundTransferQueued: EventProcessor;
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, WormholeNttManager: TestWormholeNttManager } = TestHelpers;

// Pick a real (chainId, manager) from the committed manifest so the handler's
// findByNttManager seed-lookup succeeds.
function pickManifestEntry() {
  // Use the USDm entry on Celo — stable across generations of the manifest.
  const e = findByNttManager(
    42220,
    "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
  );
  assert.ok(e, "manifest lookup failed — did generateNttAddresses.mjs run?");
  return e!;
}

// Zero-pad a 20-byte address to a 32-byte recipient (Wormhole format).
function padAddr(addr: string): string {
  return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
}

const RECIPIENT_20 = "0x1111111111111111111111111111111111111111";
const REFUND_20 = "0x2222222222222222222222222222222222222222";
const SENDER_20 = "0xabcdef0123456789abcdef0123456789abcdef00";
// bytes32 digest — any unique 32-byte hex works.
const DIGEST_1 =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_2 =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TX_HASH =
  "0x3333333333333333333333333333333333333333333333333333333333333333";

// Build an event-level mockEventData block shared across the helpers.
function mockEventData(args: {
  chainId: number;
  manager: string;
  logIndex: number;
  txHash?: string;
  txFrom?: string;
  blockNumber?: number;
  blockTimestamp?: number;
}) {
  return {
    chainId: args.chainId,
    srcAddress: args.manager,
    logIndex: args.logIndex,
    transaction: {
      hash: args.txHash ?? TX_HASH,
      from: args.txFrom ?? SENDER_20,
    },
    block: {
      number: args.blockNumber ?? 100,
      timestamp: args.blockTimestamp ?? 1_700_000_000,
    },
  };
}

async function processTransferSentPair(args: {
  mockDb: MockDb;
  chainId: number;
  manager: string;
  digest: string;
  amount: bigint;
  recipientWormholeChainId: number;
  msgSequence: number;
  detailLogIndex: number;
  digestLogIndex?: number;
  blockNumber?: number;
  blockTimestamp?: number;
  txHash?: string;
  txFrom?: string;
}) {
  let { mockDb } = args;
  const digestLogIndex = args.digestLogIndex ?? args.detailLogIndex + 2;

  const detailEvent =
    TestWormholeNttManager.TransferSentDetailed.createMockEvent({
      recipient: padAddr(RECIPIENT_20),
      refundAddress: padAddr(REFUND_20),
      amount: args.amount,
      fee: 0n,
      recipientChain: args.recipientWormholeChainId,
      msgSequence: BigInt(args.msgSequence),
      mockEventData: mockEventData({
        chainId: args.chainId,
        manager: args.manager,
        logIndex: args.detailLogIndex,
        txHash: args.txHash,
        txFrom: args.txFrom,
        blockNumber: args.blockNumber,
        blockTimestamp: args.blockTimestamp,
      }),
    });
  mockDb = await TestWormholeNttManager.TransferSentDetailed.processEvent({
    event: detailEvent,
    mockDb,
  });

  const digestEvent = TestWormholeNttManager.TransferSentDigest.createMockEvent(
    {
      digest: args.digest,
      mockEventData: mockEventData({
        chainId: args.chainId,
        manager: args.manager,
        logIndex: digestLogIndex,
        txHash: args.txHash,
        txFrom: args.txFrom,
        blockNumber: args.blockNumber,
        blockTimestamp: args.blockTimestamp,
      }),
    },
  );
  mockDb = await TestWormholeNttManager.TransferSentDigest.processEvent({
    event: digestEvent,
    mockDb,
  });

  return mockDb;
}

async function processTransferRedeemed(args: {
  mockDb: MockDb;
  chainId: number;
  manager: string;
  digest: string;
  logIndex?: number;
  blockNumber?: number;
  blockTimestamp?: number;
  txHash?: string;
}) {
  const event = TestWormholeNttManager.TransferRedeemed.createMockEvent({
    digest: args.digest,
    mockEventData: mockEventData({
      chainId: args.chainId,
      manager: args.manager,
      logIndex: args.logIndex ?? 1,
      txHash: args.txHash ?? TX_HASH,
      blockNumber: args.blockNumber,
      blockTimestamp: args.blockTimestamp,
    }),
  });
  return TestWormholeNttManager.TransferRedeemed.processEvent({
    event,
    mockDb: args.mockDb,
  });
}

describe("Bridge-flows handlers — replay idempotency", () => {
  it("replaying the same TransferSent pair does not double-count SENT rollups", async () => {
    const e = pickManifestEntry();
    let mockDb = MockDb.createMockDb();

    // First fire
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: e.chainId,
      manager: e.nttManagerProxy,
      digest: DIGEST_1,
      amount: 1000n,
      recipientWormholeChainId: 48, // Monad — counterparty of Celo
      msgSequence: 1,
      detailLogIndex: 4,
    });

    const snapAfterFirst = mockDb.entities.BridgeDailySnapshot.getAll();
    assert.equal(snapAfterFirst.length, 1, "one snapshot after first send");
    assert.equal(snapAfterFirst[0].sentCount, 1);
    assert.equal(snapAfterFirst[0].sentVolume, 1000n);

    const bridgerId = SENDER_20;
    const bridger = mockDb.entities.BridgeBridger.get(bridgerId);
    assert.equal(bridger?.totalSentCount, 1, "bridger count is 1");

    // Replay — same events, same logIndices. Handlers should no-op on rollups.
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: e.chainId,
      manager: e.nttManagerProxy,
      digest: DIGEST_1,
      amount: 1000n,
      recipientWormholeChainId: 48,
      msgSequence: 1,
      detailLogIndex: 4,
    });

    const snapAfterReplay = mockDb.entities.BridgeDailySnapshot.getAll();
    assert.equal(
      snapAfterReplay[0].sentCount,
      1,
      "sent count must stay at 1 on replay",
    );
    assert.equal(
      snapAfterReplay[0].sentVolume,
      1000n,
      "sent volume must stay at 1000 on replay",
    );

    const bridgerAfter = mockDb.entities.BridgeBridger.get(bridgerId);
    assert.equal(
      bridgerAfter?.totalSentCount,
      1,
      "bridger count must stay at 1 on replay",
    );
  });

  it("replaying TransferRedeemed does not double-count DELIVERED rollups", async () => {
    const e = pickManifestEntry();
    // Counterparty NTT manager on Monad (digest is the same across chains).
    const monad = findByNttManager(
      143,
      "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
    );
    assert.ok(monad);

    let mockDb = MockDb.createMockDb();

    // Source side first, so delivered rollup gate uses non-null amount.
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: e.chainId,
      manager: e.nttManagerProxy,
      digest: DIGEST_1,
      amount: 500n,
      recipientWormholeChainId: 48,
      msgSequence: 1,
      detailLogIndex: 4,
    });

    // Deliver on the destination chain.
    mockDb = await processTransferRedeemed({
      mockDb,
      chainId: 143,
      manager: monad!.nttManagerProxy,
      digest: DIGEST_1,
      blockTimestamp: 1_700_001_000,
      txHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
    });

    const after1 = mockDb.entities.BridgeDailySnapshot.getAll();
    const total1 = after1.reduce((a, s) => a + s.deliveredCount, 0);
    assert.equal(total1, 1, "delivered count = 1 after first redeem");

    // Replay the redeem
    mockDb = await processTransferRedeemed({
      mockDb,
      chainId: 143,
      manager: monad!.nttManagerProxy,
      digest: DIGEST_1,
      blockTimestamp: 1_700_001_000,
      txHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
    });

    const after2 = mockDb.entities.BridgeDailySnapshot.getAll();
    const total2 = after2.reduce((a, s) => a + s.deliveredCount, 0);
    assert.equal(total2, 1, "delivered count must stay at 1 on replay");
  });
});

describe("Bridge-flows handlers — destination-first race", () => {
  it("TransferRedeemed before source; source arrives; rollups fire exactly once", async () => {
    const e = pickManifestEntry();
    const monad = findByNttManager(
      143,
      "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
    );
    assert.ok(monad);

    let mockDb = MockDb.createMockDb();

    // Dest fires first — amount unknown, delivered rollup skipped.
    mockDb = await processTransferRedeemed({
      mockDb,
      chainId: 143,
      manager: monad!.nttManagerProxy,
      digest: DIGEST_1,
      blockTimestamp: 1_700_001_000,
    });

    const snapAfterDest = mockDb.entities.BridgeDailySnapshot.getAll();
    assert.equal(
      snapAfterDest.reduce((a, s) => a + s.deliveredCount, 0),
      0,
      "no delivered rollup until source info arrives",
    );

    // Source arrives — SENT rollup + delivered catch-up rollup fire.
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: e.chainId,
      manager: e.nttManagerProxy,
      digest: DIGEST_1,
      amount: 500n,
      recipientWormholeChainId: 48,
      msgSequence: 1,
      detailLogIndex: 4,
    });

    const snaps = mockDb.entities.BridgeDailySnapshot.getAll();
    const totalSent = snaps.reduce((a, s) => a + s.sentCount, 0);
    const totalDelivered = snaps.reduce((a, s) => a + s.deliveredCount, 0);
    assert.equal(totalSent, 1, "one SENT rollup after source arrives");
    assert.equal(
      totalDelivered,
      1,
      "one DELIVERED rollup after catch-up (not zero, not two)",
    );
  });
});

describe("Bridge-flows handlers — multi-send pending pairing", () => {
  it("two TransferSent pairs in one tx pair correctly by logIndex", async () => {
    const e = pickManifestEntry();
    let mockDb = MockDb.createMockDb();

    // Pair 1: detail @ logIndex 4, digest @ logIndex 6 (single-transceiver gap).
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: e.chainId,
      manager: e.nttManagerProxy,
      digest: DIGEST_1,
      amount: 111n,
      recipientWormholeChainId: 48,
      msgSequence: 10,
      detailLogIndex: 4,
      digestLogIndex: 6,
    });

    // Pair 2: detail @ logIndex 7, digest @ logIndex 9 (same tx).
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: e.chainId,
      manager: e.nttManagerProxy,
      digest: DIGEST_2,
      amount: 222n,
      recipientWormholeChainId: 48,
      msgSequence: 11,
      detailLogIndex: 7,
      digestLogIndex: 9,
    });

    const id1 = `wormhole-${DIGEST_1.toLowerCase()}`;
    const id2 = `wormhole-${DIGEST_2.toLowerCase()}`;
    const t1 = mockDb.entities.BridgeTransfer.get(id1);
    const t2 = mockDb.entities.BridgeTransfer.get(id2);
    assert.ok(t1 && t2);
    assert.equal(t1!.amount, 111n, "digest 1 paired with the first 6-arg");
    assert.equal(t2!.amount, 222n, "digest 2 paired with the second 6-arg");

    const d1 = mockDb.entities.WormholeTransferDetail.get(id1);
    const d2 = mockDb.entities.WormholeTransferDetail.get(id2);
    assert.equal(d1?.msgSequence, 10n);
    assert.equal(d2?.msgSequence, 11n);

    // Pending scratch rows are deleted when consumed.
    const pending1 = mockDb.entities.WormholeTransferPending.get(
      `${e.chainId}-${TX_HASH}-4`,
    );
    const pending2 = mockDb.entities.WormholeTransferPending.get(
      `${e.chainId}-${TX_HASH}-7`,
    );
    assert.equal(pending1, undefined, "pending 1 must be consumed");
    assert.equal(pending2, undefined, "pending 2 must be consumed");
  });
});
