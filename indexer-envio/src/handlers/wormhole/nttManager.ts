/**
 * Wormhole NttManager event handlers.
 *
 * Each event writes/updates both
 *   (a) the generic BridgeTransfer (id = "wormhole-{digest}")
 *   (b) the Wormhole-specific WormholeTransferDetail (same id)
 * then recomputes BridgeTransfer.status via computeWormholeStatus.
 * SENT/DELIVERED transitions also roll up into BridgeDailySnapshot + BridgeBridger.
 */
import { WormholeNttManager } from "generated";
import type {
  BridgeTransfer,
  WormholeTransferDetail,
  wormholeNttManager as WormholeNttManagerEntity,
  BridgeAttestation,
  BridgeDailySnapshot,
  BridgeBridger,
} from "generated";
import {
  buildTransferId,
  bytes32ToAddress,
  defaultBridgeTransfer,
  defaultBridger,
  defaultSnapshot,
  snapshotId,
  appendJsonSet,
} from "../../bridge";
import { computeWormholeStatus } from "../../wormhole/status";
import { wormholeToEvmChainId } from "../../wormhole/chainIds";
import { findByNttManager } from "../../wormhole/nttAddresses";

const PROVIDER = "WORMHOLE" as const;

type HandlerContext = {
  BridgeTransfer: {
    get: (id: string) => Promise<BridgeTransfer | undefined>;
    set: (entity: BridgeTransfer) => void;
  };
  WormholeTransferDetail: {
    get: (id: string) => Promise<WormholeTransferDetail | undefined>;
    set: (entity: WormholeTransferDetail) => void;
  };
  WormholeNttManager: {
    get: (id: string) => Promise<WormholeNttManagerEntity | undefined>;
    set: (entity: WormholeNttManagerEntity) => void;
  };
  WormholeTransferPending: {
    get: (id: string) => Promise<
      | {
          id: string;
          chainId: number;
          txHash: string;
          nttManager: string;
          sender: string;
          recipient: string;
          refundAddress: string;
          amount: bigint;
          fee: bigint;
          recipientWormholeChainId: number;
          msgSequence: bigint;
          sentBlock: bigint;
          sentTimestamp: bigint;
        }
      | undefined
    >;
    set: (entity: {
      id: string;
      chainId: number;
      txHash: string;
      nttManager: string;
      sender: string;
      recipient: string;
      refundAddress: string;
      amount: bigint;
      fee: bigint;
      recipientWormholeChainId: number;
      msgSequence: bigint;
      sentBlock: bigint;
      sentTimestamp: bigint;
    }) => void;
    deleteUnsafe?: (id: string) => void;
  };
  BridgeAttestation: { set: (entity: BridgeAttestation) => void };
  BridgeDailySnapshot: {
    get: (id: string) => Promise<BridgeDailySnapshot | undefined>;
    set: (entity: BridgeDailySnapshot) => void;
  };
  BridgeBridger: {
    get: (id: string) => Promise<BridgeBridger | undefined>;
    set: (entity: BridgeBridger) => void;
  };
};

/** Lazy-seed the WormholeNttManager lookup row from the static address manifest. */
async function ensureNttManagerSeed(
  context: HandlerContext,
  chainId: number,
  nttManager: string,
  blockTimestamp: bigint,
): Promise<WormholeNttManagerEntity | null> {
  const id = `${chainId}-${nttManager.toLowerCase()}`;
  const existing = await context.WormholeNttManager.get(id);
  if (existing) return existing;

  const entry = findByNttManager(chainId, nttManager);
  if (!entry) {
    console.warn(
      `[wormhole.nttManager] no manifest entry for ${chainId}:${nttManager} — run 'pnpm generate:ntt-addresses'`,
    );
    return null;
  }

  const seeded: WormholeNttManagerEntity = {
    id,
    chainId: entry.chainId,
    nttManager: entry.nttManagerProxy,
    transceiver: entry.transceiverProxy,
    helper: entry.helper,
    tokenAddress: entry.tokenAddress,
    tokenSymbol: entry.tokenSymbol,
    tokenDecimals: entry.tokenDecimals,
    wormholeChainId: entry.wormholeChainId,
    rateFeedId: undefined,
    seededAtTimestamp: blockTimestamp,
  };
  context.WormholeNttManager.set(seeded);
  return seeded;
}

/** Idempotent upsert of BridgeTransfer + WormholeTransferDetail keyed by digest. */
async function upsertTransferByDigest(
  context: HandlerContext,
  digest: string,
  blockTimestamp: bigint,
  transferDelta: Record<string, unknown>,
  detailDelta: Record<string, unknown>,
): Promise<BridgeTransfer> {
  const id = buildTransferId(PROVIDER, digest);
  const priorTransfer =
    (await context.BridgeTransfer.get(id)) ??
    defaultBridgeTransfer({
      id,
      provider: PROVIDER,
      providerMessageId: digest,
      blockTimestamp,
    });
  const priorDetail = (await context.WormholeTransferDetail.get(id)) ?? {
    id,
    digest: digest.toLowerCase(),
    msgSequence: undefined,
    sourceWormholeChainId: undefined,
    destWormholeChainId: undefined,
    refundAddress: undefined,
    fee: undefined,
    outboundQueuedSequence: undefined,
    inboundQueuedTimestamp: undefined,
    rateLimitedCurrentCapacity: undefined,
  };

  const nextDetail = {
    ...priorDetail,
    ...detailDelta,
  } as WormholeTransferDetail;
  const mergedTransfer = {
    ...priorTransfer,
    ...transferDelta,
    lastUpdatedAt: blockTimestamp,
  };
  const nextTransfer: BridgeTransfer = {
    ...mergedTransfer,
    status: computeWormholeStatus(mergedTransfer as BridgeTransfer, nextDetail),
  } as BridgeTransfer;

  context.BridgeTransfer.set(nextTransfer);
  context.WormholeTransferDetail.set(nextDetail);
  return nextTransfer;
}

/** Update the per-day/token/route rollup on a SENT or DELIVERED transition. */
async function updateDailySnapshot(
  context: HandlerContext,
  args: {
    blockTimestamp: bigint;
    tokenSymbol: string;
    sourceChainId: number;
    destChainId: number;
    sentDelta?: { count: number; volume: bigint };
    deliveredDelta?: { count: number; volume: bigint };
    cancelledDelta?: { count: number };
  },
) {
  const { id, date } = snapshotId({
    blockTimestamp: args.blockTimestamp,
    provider: PROVIDER,
    tokenSymbol: args.tokenSymbol,
    sourceChainId: args.sourceChainId,
    destChainId: args.destChainId,
  });
  const prior =
    (await context.BridgeDailySnapshot.get(id)) ??
    defaultSnapshot({
      id,
      date,
      provider: PROVIDER,
      tokenSymbol: args.tokenSymbol,
      sourceChainId: args.sourceChainId,
      destChainId: args.destChainId,
      blockTimestamp: args.blockTimestamp,
    });
  context.BridgeDailySnapshot.set({
    ...prior,
    sentCount: prior.sentCount + (args.sentDelta?.count ?? 0),
    sentVolume: prior.sentVolume + (args.sentDelta?.volume ?? 0n),
    // USD pricing deferred to client-side in v1 — see plan §1.5
    deliveredCount: prior.deliveredCount + (args.deliveredDelta?.count ?? 0),
    deliveredVolume:
      prior.deliveredVolume + (args.deliveredDelta?.volume ?? 0n),
    cancelledCount: prior.cancelledCount + (args.cancelledDelta?.count ?? 0),
    updatedAt: args.blockTimestamp,
  });
}

/** Update per-sender roll-up on every SENT. */
async function updateBridger(
  context: HandlerContext,
  args: {
    sender: string;
    sourceChainId: number;
    tokenSymbol: string;
    blockTimestamp: bigint;
  },
) {
  const id = args.sender.toLowerCase();
  const prior =
    (await context.BridgeBridger.get(id)) ??
    defaultBridger({
      sender: args.sender,
      blockTimestamp: args.blockTimestamp,
    });
  context.BridgeBridger.set({
    ...prior,
    totalSentCount: prior.totalSentCount + 1,
    sourceChainsUsed: appendJsonSet(
      prior.sourceChainsUsed,
      String(args.sourceChainId),
    ),
    tokensUsed: appendJsonSet(prior.tokensUsed, args.tokenSymbol),
    providersUsed: appendJsonSet(prior.providersUsed, PROVIDER),
    lastSeenAt: args.blockTimestamp,
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/** TransferSent(bytes32 digest) — the 1-arg overload. Fires LAST within a source-chain tx. */
WormholeNttManager.TransferSentDigest.handler(async ({ event, context }) => {
  const digest = event.params.digest;
  const chainId = event.chainId;
  const manager = event.srcAddress.toLowerCase();
  const mgr = await ensureNttManagerSeed(
    context as HandlerContext,
    chainId,
    manager,
    BigInt(event.block.timestamp),
  );
  if (!mgr) return;

  const pendingId = `${chainId}-${event.transaction.hash.toLowerCase()}`;
  const pending = await (context as HandlerContext).WormholeTransferPending.get(
    pendingId,
  );

  // Snapshot the prior BridgeTransfer BEFORE upserting so we can detect the
  // destination-first race: if dest already delivered this digest before we
  // indexed the source, the TransferRedeemed handler couldn't update the
  // delivered snapshot (no amount/sourceChainId yet). Now that we have both,
  // backfill the delivered rollup on the day the delivery actually happened.
  const id = buildTransferId(PROVIDER, digest);
  const priorTransfer = await (context as HandlerContext).BridgeTransfer.get(
    id,
  );

  const ts = BigInt(event.block.timestamp);
  const transferDelta: Record<string, unknown> = {
    tokenSymbol: mgr.tokenSymbol,
    tokenAddress: mgr.tokenAddress,
    tokenDecimals: mgr.tokenDecimals,
    sourceChainId: chainId,
    sourceContract: manager,
    sentBlock: BigInt(event.block.number),
    sentTimestamp: ts,
    sentTxHash: event.transaction.hash,
  };
  const detailDelta: Record<string, unknown> = {};

  if (pending) {
    const destChainId = wormholeToEvmChainId(pending.recipientWormholeChainId);
    if (destChainId !== null) transferDelta.destChainId = destChainId;
    transferDelta.sender = pending.sender;
    transferDelta.recipient = pending.recipient;
    transferDelta.amount = pending.amount;
    detailDelta.msgSequence = pending.msgSequence;
    detailDelta.refundAddress = pending.refundAddress;
    detailDelta.fee = pending.fee;
    detailDelta.destWormholeChainId = pending.recipientWormholeChainId;
  }

  await upsertTransferByDigest(
    context as HandlerContext,
    digest,
    ts,
    transferDelta,
    detailDelta,
  );

  if (pending) {
    (context as HandlerContext).WormholeTransferPending.deleteUnsafe?.(
      pendingId,
    );

    const destChainId = wormholeToEvmChainId(pending.recipientWormholeChainId);
    if (destChainId !== null && pending.amount) {
      await updateDailySnapshot(context as HandlerContext, {
        blockTimestamp: ts,
        tokenSymbol: mgr.tokenSymbol,
        sourceChainId: chainId,
        destChainId,
        sentDelta: { count: 1, volume: pending.amount },
      });
      // Catch-up: if the destination event already arrived first, the
      // TransferRedeemed handler skipped the delivered rollup because amount
      // wasn't known yet. Apply it now, bucketed on the delivery day so the
      // snapshot's "delivered on day D" semantics stay correct.
      if (
        priorTransfer?.deliveredBlock !== undefined &&
        priorTransfer?.deliveredBlock !== null &&
        priorTransfer.deliveredTimestamp !== undefined &&
        priorTransfer.deliveredTimestamp !== null
      ) {
        await updateDailySnapshot(context as HandlerContext, {
          blockTimestamp: priorTransfer.deliveredTimestamp,
          tokenSymbol: mgr.tokenSymbol,
          sourceChainId: chainId,
          destChainId,
          deliveredDelta: { count: 1, volume: pending.amount },
        });
      }
      // Skip BridgeBridger update when tx.from was missing — would create a
      // phantom "" sender row that aggregates unrelated transfers. In practice
      // Envio HyperSync always supplies tx.from, but the type allows undefined
      // and an empty-string primary key would silently corrupt the rollup.
      if (pending.sender) {
        await updateBridger(context as HandlerContext, {
          sender: pending.sender,
          sourceChainId: chainId,
          tokenSymbol: mgr.tokenSymbol,
          blockTimestamp: ts,
        });
      }
    }
  }
});

/**
 * TransferSent(bytes32 recipient, bytes32 refundAddress, uint256 amount, uint256 fee,
 *   uint16 recipientChain, uint64 msgSequence) — 6-arg variant. Fires FIRST in the tx.
 *
 * We can't key by digest yet (unknown until the 1-arg variant fires), so stash
 * the payload in WormholeTransferPending keyed by (chainId, txHash). The 1-arg
 * handler above merges and deletes the pending row.
 */
WormholeNttManager.TransferSentDetailed.handler(async ({ event, context }) => {
  const p = event.params;
  const chainId = event.chainId;
  const pendingId = `${chainId}-${event.transaction.hash.toLowerCase()}`;
  (context as HandlerContext).WormholeTransferPending.set({
    id: pendingId,
    chainId,
    txHash: event.transaction.hash,
    nttManager: event.srcAddress.toLowerCase(),
    sender: event.transaction.from?.toLowerCase() ?? "",
    recipient: bytes32ToAddress(p.recipient),
    refundAddress: bytes32ToAddress(p.refundAddress),
    amount: p.amount,
    fee: p.fee,
    recipientWormholeChainId: Number(p.recipientChain),
    msgSequence: p.msgSequence,
    sentBlock: BigInt(event.block.number),
    sentTimestamp: BigInt(event.block.timestamp),
  });
});

WormholeNttManager.TransferRedeemed.handler(async ({ event, context }) => {
  const digest = event.params.digest;
  const chainId = event.chainId;
  const manager = event.srcAddress.toLowerCase();
  const mgr = await ensureNttManagerSeed(
    context as HandlerContext,
    chainId,
    manager,
    BigInt(event.block.timestamp),
  );
  const ts = BigInt(event.block.timestamp);

  const delta: Record<string, unknown> = {
    destChainId: chainId,
    destContract: manager,
    deliveredBlock: BigInt(event.block.number),
    deliveredTimestamp: ts,
    deliveredTxHash: event.transaction.hash,
  };
  if (mgr) {
    delta.tokenSymbol = mgr.tokenSymbol;
    delta.tokenAddress = mgr.tokenAddress;
    delta.tokenDecimals = mgr.tokenDecimals;
  }

  const transfer = await upsertTransferByDigest(
    context as HandlerContext,
    digest,
    ts,
    delta,
    {},
  );

  if (
    mgr &&
    transfer.sourceChainId !== undefined &&
    transfer.sourceChainId !== null &&
    transfer.amount
  ) {
    await updateDailySnapshot(context as HandlerContext, {
      blockTimestamp: ts,
      tokenSymbol: mgr.tokenSymbol,
      sourceChainId: transfer.sourceChainId,
      destChainId: chainId,
      deliveredDelta: { count: 1, volume: transfer.amount },
    });
  }
});

WormholeNttManager.MessageAttestedTo.handler(async ({ event, context }) => {
  const p = event.params;
  const ts = BigInt(event.block.timestamp);
  const id = buildTransferId(PROVIDER, p.digest);
  const attesterIdx = Number(p.index);

  const attestation: BridgeAttestation = {
    id: `${id}-${p.transceiver.toLowerCase()}-${attesterIdx}`,
    transferId: id,
    provider: PROVIDER,
    attester: p.transceiver.toLowerCase(),
    attesterIndex: attesterIdx,
    chainId: event.chainId,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: ts,
    txHash: event.transaction.hash,
  };
  (context as HandlerContext).BridgeAttestation.set(attestation);

  const prior = await (context as HandlerContext).BridgeTransfer.get(id);
  const count = (prior?.attestationCount ?? 0) + 1;
  await upsertTransferByDigest(
    context as HandlerContext,
    p.digest,
    ts,
    {
      attestationCount: count,
      firstAttestedTimestamp: prior?.firstAttestedTimestamp ?? ts,
      lastAttestedTimestamp: ts,
    },
    {},
  );
});

WormholeNttManager.OutboundTransferQueued.handler(async () => {
  // Queue status is derived client-side from detail fields when they're set via
  // other events; v1 does not persist queue-only state without a digest.
});

WormholeNttManager.OutboundTransferRateLimited.handler(async () => {
  // Rate-limited capacity is informational; not persisted in v1.
});

WormholeNttManager.OutboundTransferCancelled.handler(async () => {
  // Cancellation path is rare and would need sequence→digest lookup; deferred.
});

WormholeNttManager.InboundTransferQueued.handler(async ({ event, context }) => {
  const digest = event.params.digest;
  const ts = BigInt(event.block.timestamp);
  await upsertTransferByDigest(
    context as HandlerContext,
    digest,
    ts,
    {
      destChainId: event.chainId,
      destContract: event.srcAddress.toLowerCase(),
    },
    { inboundQueuedTimestamp: ts },
  );
});
