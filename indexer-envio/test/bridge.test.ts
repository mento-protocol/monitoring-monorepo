/// <reference types="mocha" />
/**
 * Bridge-flows pure-function tests.
 *
 * Covers the helpers in src/bridge.ts, src/wormhole/detail.ts,
 * src/wormhole/status.ts, src/wormhole/chainIds.ts, src/wormhole/nttAddresses.ts.
 *
 * Handler-level tests (event sequencing, replay idempotency, multi-send
 * pairing) live in test/bridgeHandlers.test.ts and use Envio's MockDb.
 */
import { strict as assert } from "assert";
import type { BridgeTransfer, WormholeTransferDetail } from "generated";
import {
  buildTransferId,
  snapshotId,
  defaultBridgeTransfer,
  defaultBridger,
  defaultSnapshot,
  appendJsonSet,
} from "../src/bridge";
import {
  bytes32ToAddress,
  defaultWormholeDetail,
} from "../src/wormhole/detail";
import { computeWormholeStatus } from "../src/wormhole/status";
import {
  wormholeToEvmChainId,
  WORMHOLE_TO_EVM_CHAIN_ID,
  EVM_TO_WORMHOLE_CHAIN_ID,
} from "../src/wormhole/chainIds";
import {
  findByNttManager,
  findByTransceiver,
  allEntries,
} from "../src/wormhole/nttAddresses";

describe("buildTransferId", () => {
  it("lowercases provider and message id and joins with a dash", () => {
    assert.equal(buildTransferId("WORMHOLE", "0xABC"), "wormhole-0xabc");
  });

  it("is stable across repeated calls (usable as a primary key)", () => {
    const a = buildTransferId("WORMHOLE", "0xdeadbeef");
    const b = buildTransferId("WORMHOLE", "0xdeadbeef");
    assert.equal(a, b);
  });
});

describe("bytes32ToAddress", () => {
  it("decodes a zero-padded EVM address to lowercase 0x… (20 bytes)", () => {
    // 12 bytes of zero, then 20 bytes of "0xDEADBEEF…".
    const b32 =
      "0x0000000000000000000000001111111111111111111111111111111111111111";
    assert.equal(
      bytes32ToAddress(b32),
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("preserves the raw bytes32 when upper 12 bytes are non-zero (non-EVM)", () => {
    // Properly-sized 32-byte (64 hex) input with a non-zero upper byte so we
    // actually exercise the `upper !== ADDRESS_ZERO_PADDING` branch — the
    // 66-hex-char string previously here tripped the length-mismatch early
    // return, bypassing the non-EVM decode path entirely.
    const b32 =
      "0x00ff000000000000000000001111111111111111111111111111111111111111";
    assert.equal(bytes32ToAddress(b32), b32.toLowerCase());
  });

  it("lowercases mixed-case EVM input", () => {
    const b32 =
      "0x00000000000000000000000012345678AaAaAaAaAaAaAaAaAaAaBbBbBbBbBbBb";
    assert.equal(
      bytes32ToAddress(b32),
      "0x12345678aaaaaaaaaaaaaaaaaaaabbbbbbbbbbbb",
    );
  });

  it("handles bytes32 without 0x prefix", () => {
    const b32 =
      "0000000000000000000000002222222222222222222222222222222222222222";
    assert.equal(
      bytes32ToAddress(b32),
      "0x2222222222222222222222222222222222222222",
    );
  });

  it("returns the lowercased input when the string length is unexpected", () => {
    // Not a valid bytes32 → we preserve what we got, lowercased, rather than
    // silently returning a bogus address.
    const weird = "0xDEADBEEF";
    assert.equal(bytes32ToAddress(weird), weird.toLowerCase());
  });
});

describe("appendJsonSet", () => {
  it("adds a new value to an empty array", () => {
    assert.equal(appendJsonSet("[]", "A"), '["A"]');
  });

  it("deduplicates: existing value returns the same string", () => {
    const already = '["A","B"]';
    assert.equal(appendJsonSet(already, "A"), already);
  });

  it("appends a distinct value", () => {
    assert.equal(appendJsonSet('["A"]', "B"), '["A","B"]');
  });

  it("recovers from corrupt JSON by starting a fresh set with the new value", () => {
    // Previously-observed behaviour: the catch path returns
    // JSON.stringify([value]). That's a deliberate reset, not silent drop.
    assert.equal(appendJsonSet("not json", "X"), '["X"]');
    assert.equal(appendJsonSet('{"malformed":', "Y"), '["Y"]');
  });
});

describe("snapshotId", () => {
  it("buckets timestamps to the UTC day", () => {
    const midday = 1_700_000_000n; // arbitrary
    const day = (midday / 86_400n) * 86_400n;
    const r = snapshotId({
      blockTimestamp: midday,
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
    });
    assert.equal(r.date, day);
    assert.equal(r.id, `${day.toString()}-WORMHOLE-USDm-42220-143`);
  });

  it("produces identical ids for timestamps in the same UTC day", () => {
    const dayStart = 1_699_920_000n; // 2023-11-14 00:00 UTC
    const t1 = snapshotId({
      blockTimestamp: dayStart + 100n,
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
    });
    const t2 = snapshotId({
      blockTimestamp: dayStart + 70_000n, // same day, ~19h later
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
    });
    assert.equal(t1.id, t2.id);
    assert.equal(t1.date, dayStart);
  });

  it("produces different ids across a day boundary", () => {
    const dayStart = 1_699_920_000n;
    const a = snapshotId({
      blockTimestamp: dayStart - 1n,
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
    });
    const b = snapshotId({
      blockTimestamp: dayStart,
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
    });
    assert.notEqual(a.id, b.id);
  });
});

describe("defaultBridgeTransfer / defaultBridger / defaultSnapshot / defaultWormholeDetail", () => {
  it("defaultBridgeTransfer seeds PENDING with zero counters", () => {
    const t = defaultBridgeTransfer({
      id: "wormhole-0xabc",
      provider: "WORMHOLE",
      providerMessageId: "0xABC",
      blockTimestamp: 42n,
    });
    assert.equal(t.status, "PENDING");
    assert.equal(t.attestationCount, 0);
    assert.equal(t.provider, "WORMHOLE");
    assert.equal(t.providerMessageId, "0xabc"); // lowercased
    assert.equal(t.firstSeenAt, 42n);
    assert.equal(t.lastUpdatedAt, 42n);
  });

  it("defaultBridger seeds zero counters with the sender lowercased", () => {
    const b = defaultBridger({
      sender: "0xABCDEF0123456789abcdef0123456789ABCDEF00",
      blockTimestamp: 100n,
    });
    assert.equal(b.totalSentCount, 0);
    assert.equal(b.sender, "0xabcdef0123456789abcdef0123456789abcdef00");
    assert.equal(b.firstSeenAt, 100n);
    assert.equal(b.lastSeenAt, 100n);
  });

  it("defaultSnapshot seeds zero counts and volumes", () => {
    const s = defaultSnapshot({
      id: "0-WORMHOLE-USDm-42220-143",
      date: 0n,
      provider: "WORMHOLE",
      tokenSymbol: "USDm",
      sourceChainId: 42220,
      destChainId: 143,
      blockTimestamp: 42n,
    });
    assert.equal(s.sentCount, 0);
    assert.equal(s.deliveredCount, 0);
    assert.equal(s.cancelledCount, 0);
    assert.equal(s.sentVolume, 0n);
    assert.equal(s.deliveredVolume, 0n);
  });

  it("defaultWormholeDetail lowercases the digest", () => {
    const d = defaultWormholeDetail("id", "0xABCDEF");
    assert.equal(d.digest, "0xabcdef");
    assert.equal(d.msgSequence, undefined);
    assert.equal(d.inboundQueuedTimestamp, undefined);
  });
});

describe("computeWormholeStatus — status machine", () => {
  const baseTransfer: Pick<
    BridgeTransfer,
    | "cancelledTimestamp"
    | "failedReason"
    | "deliveredBlock"
    | "attestationCount"
    | "sentBlock"
  > = {
    cancelledTimestamp: undefined,
    failedReason: undefined,
    deliveredBlock: undefined,
    attestationCount: 0,
    sentBlock: undefined,
  };
  const baseDetail: Pick<WormholeTransferDetail, "inboundQueuedTimestamp"> = {
    inboundQueuedTimestamp: undefined,
  };

  it("PENDING when no fields are set", () => {
    assert.equal(computeWormholeStatus(baseTransfer, baseDetail), "PENDING");
  });

  it("SENT when only sentBlock is set", () => {
    assert.equal(
      computeWormholeStatus({ ...baseTransfer, sentBlock: 10n }, baseDetail),
      "SENT",
    );
  });

  it("ATTESTED when attestationCount > 0 (no queue, no deliver)", () => {
    assert.equal(
      computeWormholeStatus(
        { ...baseTransfer, sentBlock: 10n, attestationCount: 1 },
        baseDetail,
      ),
      "ATTESTED",
    );
  });

  it("QUEUED_INBOUND beats ATTESTED when inboundQueuedTimestamp is set (codex #2)", () => {
    // Destination chain emission order: MessageAttestedTo fires before
    // InboundTransferQueued, so attestationCount > 0 by the time a transfer
    // is queued. QUEUED_INBOUND must win or the queue state is unreachable.
    assert.equal(
      computeWormholeStatus(
        { ...baseTransfer, sentBlock: 10n, attestationCount: 13 },
        { inboundQueuedTimestamp: 200n },
      ),
      "QUEUED_INBOUND",
    );
  });

  it("DELIVERED beats QUEUED_INBOUND (queue → redeem is terminal)", () => {
    assert.equal(
      computeWormholeStatus(
        {
          ...baseTransfer,
          sentBlock: 10n,
          attestationCount: 13,
          deliveredBlock: 20n,
        },
        { inboundQueuedTimestamp: 200n },
      ),
      "DELIVERED",
    );
  });

  it("CANCELLED beats everything (terminal)", () => {
    assert.equal(
      computeWormholeStatus(
        {
          ...baseTransfer,
          sentBlock: 10n,
          attestationCount: 13,
          deliveredBlock: 20n,
          cancelledTimestamp: 30n,
        },
        { inboundQueuedTimestamp: 200n },
      ),
      "CANCELLED",
    );
  });

  it("FAILED beats DELIVERED (terminal error)", () => {
    assert.equal(
      computeWormholeStatus(
        {
          ...baseTransfer,
          sentBlock: 10n,
          deliveredBlock: 20n,
          failedReason: "boom",
        },
        baseDetail,
      ),
      "FAILED",
    );
  });

  it("accepts a null detail and still resolves", () => {
    assert.equal(
      computeWormholeStatus({ ...baseTransfer, sentBlock: 10n }, null),
      "SENT",
    );
  });
});

describe("wormhole/chainIds — EVM ↔ Wormhole mapping", () => {
  it("maps Celo (14) ↔ 42220 and Monad (48) ↔ 143", () => {
    assert.equal(WORMHOLE_TO_EVM_CHAIN_ID[14], 42220);
    assert.equal(WORMHOLE_TO_EVM_CHAIN_ID[48], 143);
    assert.equal(EVM_TO_WORMHOLE_CHAIN_ID[42220], 14);
    assert.equal(EVM_TO_WORMHOLE_CHAIN_ID[143], 48);
  });

  it("wormholeToEvmChainId returns null for unknown ids (e.g. Solana = 1)", () => {
    assert.equal(wormholeToEvmChainId(1), null);
    assert.equal(wormholeToEvmChainId(999), null);
  });

  it("round-trips every mapped pair", () => {
    for (const [wh, evm] of Object.entries(WORMHOLE_TO_EVM_CHAIN_ID)) {
      assert.equal(EVM_TO_WORMHOLE_CHAIN_ID[evm], Number(wh));
    }
  });
});

describe("wormhole/nttAddresses — manifest lookup", () => {
  it("ships at least one entry per mapped mainnet chain", () => {
    const entries = allEntries();
    assert.ok(entries.length > 0, "manifest must be non-empty");
    const chainIds = new Set(entries.map((e) => e.chainId));
    assert.ok(chainIds.has(42220), "Celo entries expected");
    assert.ok(chainIds.has(143), "Monad entries expected");
  });

  it("findByNttManager returns a matching entry for a real manager", () => {
    const entries = allEntries();
    const sample = entries[0];
    const hit = findByNttManager(sample.chainId, sample.nttManagerProxy);
    assert.ok(hit, "real (chainId, manager) must resolve");
    assert.equal(hit!.tokenSymbol, sample.tokenSymbol);
  });

  it("findByNttManager normalizes case and is null for unknowns", () => {
    const entries = allEntries();
    const sample = entries[0];
    const upper = sample.nttManagerProxy.toUpperCase();
    assert.ok(findByNttManager(sample.chainId, upper), "case-insensitive");
    assert.equal(
      findByNttManager(
        sample.chainId,
        "0x0000000000000000000000000000000000000000",
      ),
      null,
    );
  });

  it("findByTransceiver resolves the mirror entry", () => {
    const entries = allEntries();
    const sample = entries[0];
    const hit = findByTransceiver(sample.chainId, sample.transceiverProxy);
    assert.ok(hit);
    assert.equal(hit!.nttManagerProxy, sample.nttManagerProxy);
  });
});
