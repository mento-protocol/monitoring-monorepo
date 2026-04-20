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
      tokenAddress: string;
    }>;
    WormholeTransferDetail: EntityGet<{
      id: string;
      digest: string;
      transceiverDigest?: string;
      msgSequence?: bigint;
      sourceWormholeChainId?: number;
      inboundQueuedTimestamp?: bigint;
    }>;
    WormholeNttManager: EntityGet<{ id: string; tokenSymbol: string }>;
    WormholeTransferPending: EntityGet<{ id: string; amount: bigint }>;
    WormholeDestPending: EntityGet<{
      id: string;
      chainId: number;
      txHash: string;
      transceiverDigest: string;
      sourceChainId: number;
      sourceTransceiver: string;
      sourceWormholeChainId: number;
      msgSequence: bigint;
      destTransceiver: string;
    }>;
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
    WormholeTransceiver: {
      ReceivedMessage: EventProcessor;
    };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const {
  MockDb,
  WormholeNttManager: TestWormholeNttManager,
  WormholeTransceiver: TestWormholeTransceiver,
} = TestHelpers;

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

describe("Bridge-flows handlers — tokenAddress source-chain resolution", () => {
  // Regression guard for the dest-first tokenAddress overwrite bug: hub/spoke
  // NTT deploys DIFFERENT token proxy addresses per chain, so storing the
  // dest-chain's tokenAddress on a row tagged with sourceChainId produces
  // broken explorer links in the UI. The TransferRedeemed handler must
  // seed token metadata ONLY when the source hasn't run yet, and must NOT
  // overwrite the source-chain's tokenAddress.
  it("source-first: TransferRedeemed does not overwrite the source-chain tokenAddress", async () => {
    const celo = pickManifestEntry(); // Celo USDm — source
    const monad = findByNttManager(
      143,
      "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
    );
    assert.ok(monad);
    let mockDb = MockDb.createMockDb();

    // Source-first: TransferSent on Celo sets tokenAddress = Celo USDm.
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: celo.chainId,
      manager: celo.nttManagerProxy,
      digest: DIGEST_1,
      amount: 1000n,
      recipientWormholeChainId: 48,
      msgSequence: 1,
      detailLogIndex: 4,
      blockTimestamp: 1_700_000_000,
    });

    const afterSource = mockDb.entities.BridgeTransfer.get(
      `wormhole-${DIGEST_1.toLowerCase()}`,
    );
    assert.equal(
      afterSource!.tokenAddress.toLowerCase(),
      celo.tokenAddress.toLowerCase(),
      "source-side seeds Celo tokenAddress",
    );

    // Dest TransferRedeemed on Monad fires later. Must NOT overwrite.
    mockDb = await processTransferRedeemed({
      mockDb,
      chainId: 143,
      manager: monad!.nttManagerProxy,
      digest: DIGEST_1,
      blockTimestamp: 1_700_001_000,
      txHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
    });

    const afterDest = mockDb.entities.BridgeTransfer.get(
      `wormhole-${DIGEST_1.toLowerCase()}`,
    );
    assert.equal(
      afterDest!.tokenAddress.toLowerCase(),
      celo.tokenAddress.toLowerCase(),
      "TransferRedeemed leaves source-chain tokenAddress intact (must not overwrite with Monad's address)",
    );
    assert.notEqual(
      afterDest!.tokenAddress.toLowerCase(),
      monad!.tokenAddress.toLowerCase(),
      "tokenAddress is NOT the dest-chain token proxy",
    );
  });

  it("dest-first: TransferRedeemed seeds, then TransferSent overwrites with the source-chain tokenAddress", async () => {
    const celo = pickManifestEntry();
    const monad = findByNttManager(
      143,
      "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
    );
    assert.ok(monad);
    let mockDb = MockDb.createMockDb();

    // Dest-first: TransferRedeemed seeds dest tokenAddress (because source
    // hasn't run yet — this is deliberately the wrong address initially,
    // corrected below).
    mockDb = await processTransferRedeemed({
      mockDb,
      chainId: 143,
      manager: monad!.nttManagerProxy,
      digest: DIGEST_1,
      blockTimestamp: 1_700_001_000,
    });

    // Source arrives — must overwrite with Celo tokenAddress.
    mockDb = await processTransferSentPair({
      mockDb,
      chainId: celo.chainId,
      manager: celo.nttManagerProxy,
      digest: DIGEST_1,
      amount: 1000n,
      recipientWormholeChainId: 48,
      msgSequence: 1,
      detailLogIndex: 4,
      blockTimestamp: 1_700_002_000,
      txHash:
        "0x5555555555555555555555555555555555555555555555555555555555555555",
    });

    const final = mockDb.entities.BridgeTransfer.get(
      `wormhole-${DIGEST_1.toLowerCase()}`,
    );
    assert.equal(
      final!.tokenAddress.toLowerCase(),
      celo.tokenAddress.toLowerCase(),
      "after source catches up, tokenAddress is the source-chain proxy",
    );
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

describe("Bridge-flows handlers — MessageAttestedTo interaction", () => {
  it("increments attestationCount and writes BridgeAttestation row", async () => {
    const e = pickManifestEntry();
    let mockDb = MockDb.createMockDb();
    const attesterAddr = "0x9999999999999999999999999999999999999999";
    const id = `wormhole-${DIGEST_1.toLowerCase()}`;

    const event = TestWormholeNttManager.MessageAttestedTo.createMockEvent({
      digest: DIGEST_1,
      transceiver: attesterAddr,
      index: 0n,
      mockEventData: mockEventData({
        chainId: e.chainId,
        manager: e.nttManagerProxy,
        logIndex: 2,
      }),
    });
    mockDb = await TestWormholeNttManager.MessageAttestedTo.processEvent({
      event,
      mockDb,
    });

    const transfer = mockDb.entities.BridgeTransfer.get(id);
    assert.equal(transfer?.attestationCount, 1);
    assert.equal(
      transfer?.status,
      "ATTESTED",
      "status promotes from PENDING to ATTESTED",
    );

    const attestationId = `${id}-${attesterAddr}-0`;
    const attestation = mockDb.entities.BridgeAttestation.get(attestationId);
    assert.ok(attestation, "BridgeAttestation row written");
    assert.equal(attestation!.transferId, id);
  });

  it("is replay-idempotent (duplicate event does not double attestationCount)", async () => {
    const e = pickManifestEntry();
    let mockDb = MockDb.createMockDb();
    const attesterAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const id = `wormhole-${DIGEST_1.toLowerCase()}`;

    const makeEvent = () =>
      TestWormholeNttManager.MessageAttestedTo.createMockEvent({
        digest: DIGEST_1,
        transceiver: attesterAddr,
        index: 0n,
        mockEventData: mockEventData({
          chainId: e.chainId,
          manager: e.nttManagerProxy,
          logIndex: 2,
        }),
      });

    mockDb = await TestWormholeNttManager.MessageAttestedTo.processEvent({
      event: makeEvent(),
      mockDb,
    });
    mockDb = await TestWormholeNttManager.MessageAttestedTo.processEvent({
      event: makeEvent(),
      mockDb,
    });

    const transfer = mockDb.entities.BridgeTransfer.get(id);
    assert.equal(
      transfer?.attestationCount,
      1,
      "replay of same attestation does not double the counter",
    );
  });
});

describe("Bridge-flows handlers — InboundTransferQueued interaction", () => {
  it("sets QUEUED_INBOUND and wins over ATTESTED (status-machine precedence)", async () => {
    const e = pickManifestEntry();
    let mockDb = MockDb.createMockDb();
    const id = `wormhole-${DIGEST_1.toLowerCase()}`;
    const attesterAddr = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // Dest-chain emission order in a rate-limited transfer is:
    // MessageAttestedTo → InboundTransferQueued.
    const attestEvent =
      TestWormholeNttManager.MessageAttestedTo.createMockEvent({
        digest: DIGEST_1,
        transceiver: attesterAddr,
        index: 0n,
        mockEventData: mockEventData({
          chainId: e.chainId,
          manager: e.nttManagerProxy,
          logIndex: 2,
        }),
      });
    mockDb = await TestWormholeNttManager.MessageAttestedTo.processEvent({
      event: attestEvent,
      mockDb,
    });
    assert.equal(
      mockDb.entities.BridgeTransfer.get(id)?.status,
      "ATTESTED",
      "before the queue event, status is ATTESTED",
    );

    const queueEvent =
      TestWormholeNttManager.InboundTransferQueued.createMockEvent({
        digest: DIGEST_1,
        mockEventData: mockEventData({
          chainId: e.chainId,
          manager: e.nttManagerProxy,
          logIndex: 3,
        }),
      });
    mockDb = await TestWormholeNttManager.InboundTransferQueued.processEvent({
      event: queueEvent,
      mockDb,
    });

    const transfer = mockDb.entities.BridgeTransfer.get(id);
    assert.equal(
      transfer?.status,
      "QUEUED_INBOUND",
      "queue event overrides ATTESTED in status machine (codex #2 fix)",
    );

    const detail = mockDb.entities.WormholeTransferDetail.get(id);
    assert.ok(
      detail?.inboundQueuedTimestamp,
      "inboundQueuedTimestamp is populated",
    );
  });
});

describe("Bridge-flows handlers — ReceivedMessage (transceiver) interaction", () => {
  // Since the `digest` emitted by WormholeTransceiver.ReceivedMessage is the
  // transceiver-layer digest (a DIFFERENT bytestring from the manager-layer
  // digest used by TransferSent/MessageAttestedTo/TransferRedeemed), the
  // handler cannot create or enrich a BridgeTransfer by that digest — it
  // would produce orphans. Instead, ReceivedMessage writes a
  // WormholeDestPending scratch keyed by (chainId, txHash, logIndex), and
  // MessageAttestedTo / TransferRedeemed walk backward to find it and stamp
  // the source identity onto the correct BridgeTransfer row.
  const TRANSCEIVER_DIGEST = DIGEST_1; // shape-wise arbitrary; labelled for clarity
  const MANAGER_DIGEST = DIGEST_2;

  it("writes scratch only (no BridgeTransfer) when dest-side arrives first", async () => {
    const e = pickManifestEntry();
    const monad = findByNttManager(
      143,
      "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
    );
    assert.ok(monad);
    let mockDb = MockDb.createMockDb();

    const event = TestWormholeTransceiver.ReceivedMessage.createMockEvent({
      digest: TRANSCEIVER_DIGEST,
      emitterChainId: 14,
      emitterAddress: padAddr(e.transceiverProxy),
      sequence: 42n,
      mockEventData: mockEventData({
        chainId: 143,
        manager: monad!.transceiverProxy,
        logIndex: 5,
      }),
    });
    mockDb = await TestWormholeTransceiver.ReceivedMessage.processEvent({
      event,
      mockDb,
    });

    // No BridgeTransfer keyed by the transceiver digest.
    assert.equal(
      mockDb.entities.BridgeTransfer.get(
        `wormhole-${TRANSCEIVER_DIGEST.toLowerCase()}`,
      ),
      undefined,
      "ReceivedMessage must not create a BridgeTransfer keyed by the transceiver digest",
    );

    // Scratch row written keyed by (chainId, txHash, logIndex).
    const pendingId = `143-${TX_HASH.toLowerCase()}-5`;
    const pending = mockDb.entities.WormholeDestPending.get(pendingId);
    assert.ok(pending, "WormholeDestPending scratch row is written");
    assert.equal(pending!.sourceChainId, 42220);
    assert.equal(pending!.sourceWormholeChainId, 14);
    assert.equal(
      pending!.sourceTransceiver.toLowerCase(),
      e.transceiverProxy.toLowerCase(),
    );
    assert.equal(pending!.msgSequence, 42n);
    assert.equal(pending!.transceiverDigest, TRANSCEIVER_DIGEST.toLowerCase());
  });

  it("MessageAttestedTo drains the scratch and stamps source identity + transceiverDigest", async () => {
    const e = pickManifestEntry(); // Celo USDm — the source side
    const monad = findByNttManager(
      143,
      "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
    );
    assert.ok(monad);
    let mockDb = MockDb.createMockDb();

    // 1. Dest-side ReceivedMessage (writes scratch).
    const receivedEvent =
      TestWormholeTransceiver.ReceivedMessage.createMockEvent({
        digest: TRANSCEIVER_DIGEST,
        emitterChainId: 14,
        emitterAddress: padAddr(e.transceiverProxy),
        sequence: 42n,
        mockEventData: mockEventData({
          chainId: 143,
          manager: monad!.transceiverProxy,
          logIndex: 5,
        }),
      });
    mockDb = await TestWormholeTransceiver.ReceivedMessage.processEvent({
      event: receivedEvent,
      mockDb,
    });

    // 2. Dest-side MessageAttestedTo fires same tx at a higher logIndex.
    const attestedEvent =
      TestWormholeNttManager.MessageAttestedTo.createMockEvent({
        digest: MANAGER_DIGEST,
        transceiver: monad!.transceiverProxy,
        index: 0,
        mockEventData: mockEventData({
          chainId: 143,
          manager: monad!.nttManagerProxy,
          logIndex: 7,
        }),
      });
    mockDb = await TestWormholeNttManager.MessageAttestedTo.processEvent({
      event: attestedEvent,
      mockDb,
    });

    // Scratch row is gone.
    assert.equal(
      mockDb.entities.WormholeDestPending.get(`143-${TX_HASH.toLowerCase()}-5`),
      undefined,
      "scratch row is deleted after MessageAttestedTo drains it",
    );

    // BridgeTransfer is keyed by the MANAGER digest, and carries the source
    // identity that was drained from the scratch.
    const transfer = mockDb.entities.BridgeTransfer.get(
      `wormhole-${MANAGER_DIGEST.toLowerCase()}`,
    );
    assert.ok(
      transfer,
      "BridgeTransfer is created keyed by the manager digest",
    );
    assert.equal(transfer!.sourceChainId, 42220);
    assert.equal(transfer!.destChainId, 143);
    assert.equal(transfer!.attestationCount, 1);

    const detail = mockDb.entities.WormholeTransferDetail.get(
      `wormhole-${MANAGER_DIGEST.toLowerCase()}`,
    );
    assert.equal(
      detail?.transceiverDigest,
      TRANSCEIVER_DIGEST.toLowerCase(),
      "transceiverDigest is stamped from the scratch",
    );
    assert.equal(detail?.msgSequence, 42n);
    assert.equal(detail?.sourceWormholeChainId, 14);
  });

  it("replay (no MessageAttestedTo) leaves the scratch but does not pollute BridgeTransfer", async () => {
    // When a VAA is replayed against an already-executed digest, the
    // NttManager silently returns — MessageAttestedTo does not fire — so
    // nothing drains the scratch. That's acceptable: the scratch stays
    // keyed by tx hash, never surfaces in the main dashboard views, and a
    // periodic sweep can clean it up if the count ever matters.
    const e = pickManifestEntry();
    const monad = findByNttManager(
      143,
      "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
    );
    assert.ok(monad);
    let mockDb = MockDb.createMockDb();

    const event = TestWormholeTransceiver.ReceivedMessage.createMockEvent({
      digest: TRANSCEIVER_DIGEST,
      emitterChainId: 14,
      emitterAddress: padAddr(e.transceiverProxy),
      sequence: 99n,
      mockEventData: mockEventData({
        chainId: 143,
        manager: monad!.transceiverProxy,
        logIndex: 5,
      }),
    });
    mockDb = await TestWormholeTransceiver.ReceivedMessage.processEvent({
      event,
      mockDb,
    });

    assert.equal(
      mockDb.entities.BridgeTransfer.get(
        `wormhole-${TRANSCEIVER_DIGEST.toLowerCase()}`,
      ),
      undefined,
      "no BridgeTransfer created under the transceiver digest",
    );
    assert.ok(
      mockDb.entities.WormholeDestPending.get(`143-${TX_HASH.toLowerCase()}-5`),
      "scratch persists when MessageAttestedTo never fires (replay case)",
    );
  });
});
