/**
 * Issue #1054 scenario 6 (Wormhole half) — after a COMPLETE NTT transfer flow
 * (source TransferSentDetailed+Digest, dest ReceivedMessage, dest
 * MessageAttestedTo, dest TransferRedeemed), both scratch tables —
 * `WormholeTransferPending` (source-side pairing scratch) and
 * `WormholeDestPending` (dest-side transceiver-digest scratch) — must end at
 * zero rows. `test/bridgeHandlers.test.ts` already asserts individual scratch
 * rows are consumed by id; this file adds the end-to-end `getAll().length ===
 * 0` assertion across both tables for a full round trip, which no existing
 * test does.
 */
import { strict as assert } from "assert";
import { findByNttManager } from "../src/wormhole/nttAddresses.js";
import {
  indexerTestHelpers,
  type EntityCollection,
  type EntityReader,
  type MockDbWith,
} from "./helpers/indexerTestHarness.js";

// Side-effect: register handlers with Envio.
import "../src/EventHandlers.ts";

type MockDb = MockDbWith<{
  BridgeTransfer: EntityReader<{
    id: string;
    status: string;
    sourceChainId?: number;
    destChainId?: number;
  }>;
  WormholeTransferPending: EntityCollection<{ id: string }>;
  WormholeDestPending: EntityCollection<{ id: string }>;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const {
  MockDb,
  WormholeNttManager: TestWormholeNttManager,
  WormholeTransceiver: TestWormholeTransceiver,
} = TestHelpers;

// Celo USDm entry — stable across generations of the manifest (same pattern
// as test/bridgeHandlers.test.ts).
function celoEntry() {
  const e = findByNttManager(
    42220,
    "0xa4096343485a44c0f8d05ae6da311c18d63e38bc",
  );
  assert.ok(e, "manifest lookup failed — did generateNttAddresses.mjs run?");
  return e!;
}
function monadEntry() {
  const e = findByNttManager(143, "0xa4096343485a44c0f8d05ae6da311c18d63e38bc");
  assert.ok(e, "manifest lookup failed — did generateNttAddresses.mjs run?");
  return e!;
}

function padAddr(addr: string): string {
  return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
}

const RECIPIENT_20 = "0x1111111111111111111111111111111111111111";
const REFUND_20 = "0x2222222222222222222222222222222222222222";
const SENDER_20 = "0xabcdef0123456789abcdef0123456789abcdef00";
const MANAGER_DIGEST =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const TRANSCEIVER_DIGEST =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SOURCE_TX_HASH =
  "0x3333333333333333333333333333333333333333333333333333333333333333";
const DEST_TX_HASH =
  "0x4444444444444444444444444444444444444444444444444444444444444444";

function mockEventData(args: {
  chainId: number;
  manager: string;
  logIndex: number;
  txHash: string;
  txFrom?: string;
  blockNumber?: number;
  blockTimestamp?: number;
}) {
  return {
    chainId: args.chainId,
    srcAddress: args.manager,
    logIndex: args.logIndex,
    transaction: { hash: args.txHash, from: args.txFrom ?? SENDER_20 },
    block: {
      number: args.blockNumber ?? 100,
      timestamp: args.blockTimestamp ?? 1_700_000_000,
    },
  };
}

describe("Wormhole complete transfer flow — pending scratch fully drains", () => {
  it("source pairing + dest ReceivedMessage/MessageAttestedTo/TransferRedeemed leaves both scratch tables at 0 rows", async () => {
    const celo = celoEntry();
    const monad = monadEntry();
    let mockDb = MockDb.createMockDb();

    // --- Source chain (Celo): TransferSentDetailed + TransferSentDigest ---
    const detailEvent =
      TestWormholeNttManager.TransferSentDetailed.createMockEvent({
        recipient: padAddr(RECIPIENT_20),
        refundAddress: padAddr(REFUND_20),
        amount: 1_000n,
        fee: 0n,
        recipientChain: 48, // Monad
        msgSequence: 7n,
        mockEventData: mockEventData({
          chainId: celo.chainId,
          manager: celo.nttManagerProxy,
          logIndex: 4,
          txHash: SOURCE_TX_HASH,
        }),
      });
    mockDb = await TestWormholeNttManager.TransferSentDetailed.processEvent({
      event: detailEvent,
      mockDb,
    });
    const digestEvent =
      TestWormholeNttManager.TransferSentDigest.createMockEvent({
        digest: MANAGER_DIGEST,
        mockEventData: mockEventData({
          chainId: celo.chainId,
          manager: celo.nttManagerProxy,
          logIndex: 6,
          txHash: SOURCE_TX_HASH,
        }),
      });
    mockDb = await TestWormholeNttManager.TransferSentDigest.processEvent({
      event: digestEvent,
      mockDb,
    });

    assert.equal(
      mockDb.entities.WormholeTransferPending.getAll().length,
      0,
      "source-side scratch is drained once the digest event pairs it",
    );
    const afterSource = mockDb.entities.BridgeTransfer.get(
      `wormhole-${MANAGER_DIGEST.toLowerCase()}`,
    );
    assert.equal(afterSource?.status, "SENT");

    // --- Dest chain (Monad): ReceivedMessage (transceiver-layer digest) ---
    const receivedEvent =
      TestWormholeTransceiver.ReceivedMessage.createMockEvent({
        digest: TRANSCEIVER_DIGEST,
        emitterChainId: 14, // Celo
        emitterAddress: padAddr(celo.transceiverProxy),
        sequence: 7n,
        mockEventData: mockEventData({
          chainId: monad.chainId,
          manager: monad.transceiverProxy,
          logIndex: 5,
          txHash: DEST_TX_HASH,
        }),
      });
    mockDb = await TestWormholeTransceiver.ReceivedMessage.processEvent({
      event: receivedEvent,
      mockDb,
    });
    assert.equal(
      mockDb.entities.WormholeDestPending.getAll().length,
      1,
      "dest-side scratch is written pending the manager-layer MessageAttestedTo",
    );

    // --- Dest chain: MessageAttestedTo (manager-layer digest, same tx, higher logIndex) ---
    const attestedEvent =
      TestWormholeNttManager.MessageAttestedTo.createMockEvent({
        digest: MANAGER_DIGEST,
        transceiver: monad.transceiverProxy,
        index: 0n,
        mockEventData: mockEventData({
          chainId: monad.chainId,
          manager: monad.nttManagerProxy,
          logIndex: 7,
          txHash: DEST_TX_HASH,
        }),
      });
    mockDb = await TestWormholeNttManager.MessageAttestedTo.processEvent({
      event: attestedEvent,
      mockDb,
    });
    assert.equal(
      mockDb.entities.WormholeDestPending.getAll().length,
      0,
      "MessageAttestedTo drains the WormholeDestPending scratch",
    );

    // --- Dest chain: TransferRedeemed completes delivery ---
    const redeemedEvent =
      TestWormholeNttManager.TransferRedeemed.createMockEvent({
        digest: MANAGER_DIGEST,
        mockEventData: mockEventData({
          chainId: monad.chainId,
          manager: monad.nttManagerProxy,
          logIndex: 8,
          txHash: DEST_TX_HASH,
        }),
      });
    mockDb = await TestWormholeNttManager.TransferRedeemed.processEvent({
      event: redeemedEvent,
      mockDb,
    });

    const finalTransfer = mockDb.entities.BridgeTransfer.get(
      `wormhole-${MANAGER_DIGEST.toLowerCase()}`,
    );
    assert.equal(finalTransfer?.status, "DELIVERED");
    assert.equal(finalTransfer?.sourceChainId, celo.chainId);
    assert.equal(finalTransfer?.destChainId, monad.chainId);

    assert.equal(
      mockDb.entities.WormholeTransferPending.getAll().length,
      0,
      "WormholeTransferPending has 0 rows after a complete round trip",
    );
    assert.equal(
      mockDb.entities.WormholeDestPending.getAll().length,
      0,
      "WormholeDestPending has 0 rows after a complete round trip",
    );
  });
});
