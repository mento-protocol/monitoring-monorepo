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
  BridgeAttestation,
  BridgeTransfer,
  WormholeTransferDetail,
  wormholeNttManager as WormholeNttManagerEntity,
} from "generated";
import {
  buildTransferId,
  defaultBridgeTransfer,
  defaultBridger,
  defaultSnapshot,
  snapshotId,
  appendJsonSet,
} from "../../bridge";
import { bytes32ToAddress, defaultWormholeDetail } from "../../wormhole/detail";
import { computeWormholeStatus } from "../../wormhole/status";
import { wormholeToEvmChainId } from "../../wormhole/chainIds";
import { findByNttManager } from "../../wormhole/nttAddresses";
import {
  findPendingScratch,
  findAndDrainPendingScratch,
} from "../../wormhole/pairing";
import type { WormholeHandlerContext } from "../../wormhole/handlerContext";

const PROVIDER = "WORMHOLE" as const;

type HandlerContext = WormholeHandlerContext;

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
  const priorDetail =
    (await context.WormholeTransferDetail.get(id)) ??
    defaultWormholeDetail(id, digest);

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

  // Pair with the TransferSentDetailed row written earlier in the same tx.
  // The 6-arg variant fires first; the digest fires later with an arbitrary
  // number of intermediate Wormhole-core / transceiver logs between them
  // (up to ~50 on Monad). Done before the manifest check so we reap the
  // scratch even when the NttManager isn't in the manifest (yaml drift) —
  // otherwise every drift-affected tx would leak a pending row. Source-side
  // uses the non-drain variant because it only wants to delete AFTER the
  // upsert succeeds.
  const { row: pending, id: pendingId } = await findPendingScratch(
    (context as HandlerContext).WormholeTransferPending,
    {
      chainId,
      txHash: event.transaction.hash,
      currentLogIndex: event.logIndex,
    },
  );

  const mgr = await ensureNttManagerSeed(
    context as HandlerContext,
    chainId,
    manager,
    BigInt(event.block.timestamp),
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
  // Manifest miss (yaml declares an NttManager that hasn't been regenerated
  // into config/nttAddresses.json) persists source identity + sender/amount
  // in a degraded "UNKNOWN"-token mode rather than dropping the transfer
  // entirely — we'd rather have recoverable data with wrong symbol than
  // silent loss. Rollups (daily snapshot, bridger) are gated on mgr below so
  // they stay consistent with what the manifest knows.
  const transferDelta: Record<string, unknown> = {
    sourceChainId: chainId,
    sourceContract: manager,
    sentBlock: BigInt(event.block.number),
    sentTimestamp: ts,
    sentTxHash: event.transaction.hash,
  };
  if (mgr) {
    transferDelta.tokenSymbol = mgr.tokenSymbol;
    transferDelta.tokenAddress = mgr.tokenAddress;
    transferDelta.tokenDecimals = mgr.tokenDecimals;
  }
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

    // Rollups require resolved token metadata — skip on manifest miss.
    // The degraded BridgeTransfer row above is still written so the transfer
    // is not lost; operator can rerun `pnpm generate:ntt-addresses` + replay
    // to backfill rollups.
    const destChainId = wormholeToEvmChainId(pending.recipientWormholeChainId);
    if (mgr && destChainId !== null && pending.amount) {
      // Replay-idempotent: only apply the SENT rollup on the first-time
      // transition (priorTransfer had no sentBlock yet). On a reorg/restart
      // replay priorTransfer.sentBlock is already set, so we skip.
      const firstTimeSent =
        priorTransfer?.sentBlock == null || priorTransfer.sentBlock === 0n;
      if (firstTimeSent) {
        await updateDailySnapshot(context as HandlerContext, {
          blockTimestamp: ts,
          tokenSymbol: mgr.tokenSymbol,
          sourceChainId: chainId,
          destChainId,
          sentDelta: { count: 1, volume: pending.amount },
        });
        // BridgeBridger is also a monotonic rollup; same replay guard. Also
        // skip when tx.from was missing — would create a phantom "" sender
        // row that aggregates unrelated transfers.
        if (pending.sender) {
          await updateBridger(context as HandlerContext, {
            sender: pending.sender,
            sourceChainId: chainId,
            tokenSymbol: mgr.tokenSymbol,
            blockTimestamp: ts,
          });
        }
      }
      // Dest-first catch-up: fire the delivered rollup only on first-time
      // transition (delivered block known, but amount/source weren't until
      // now). priorTransfer.amount == null is the tight invariant — on replay
      // it's already set, so this branch doesn't fire.
      const needsDeliveredCatchUp =
        priorTransfer?.deliveredBlock != null &&
        priorTransfer?.deliveredTimestamp != null &&
        priorTransfer?.amount == null;
      if (needsDeliveredCatchUp) {
        await updateDailySnapshot(context as HandlerContext, {
          blockTimestamp: priorTransfer!.deliveredTimestamp!,
          tokenSymbol: mgr.tokenSymbol,
          sourceChainId: chainId,
          destChainId,
          deliveredDelta: { count: 1, volume: pending.amount },
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
 * the payload in WormholeTransferPending keyed by (chainId, txHash, logIndex).
 * logIndex is needed because a single tx can (in principle — via a wrapper
 * contract) emit multiple TransferSent pairs; keying only by txHash would
 * cause later sends to overwrite earlier pending rows and join the wrong
 * payload to the wrong digest. The matching digest handler walks backward
 * a few logIndex offsets to find this row.
 */
WormholeNttManager.TransferSentDetailed.handler(async ({ event, context }) => {
  const p = event.params;
  const chainId = event.chainId;
  const pendingId = `${chainId}-${event.transaction.hash.toLowerCase()}-${event.logIndex}`;
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
  const id = buildTransferId(PROVIDER, digest);

  // Snapshot prior state before upserting so we can gate the delivered rollup
  // on the first-time SENT→DELIVERED transition. Replay/reorg would otherwise
  // double-count (counter entities are monotonic).
  const priorTransfer = await (context as HandlerContext).BridgeTransfer.get(
    id,
  );
  const alreadyDelivered =
    priorTransfer?.deliveredBlock != null &&
    priorTransfer.deliveredBlock !== 0n;

  const delta: Record<string, unknown> = {
    destChainId: chainId,
    destContract: manager,
    deliveredBlock: BigInt(event.block.number),
    deliveredTimestamp: ts,
    deliveredTxHash: event.transaction.hash,
  };
  if (mgr) {
    // Destination handler: seed token metadata ONLY for dest-first race rows
    // (where the source TransferSent hasn't fired yet). Once the source-side
    // TransferSent handler has set tokenAddress, don't overwrite — the
    // destination chain's tokenAddress points to a different proxy (hub/spoke
    // NTT deploys a distinct address per chain) and would break UI links that
    // assume the stored tokenAddress corresponds to sourceChainId.
    const sourceHasRun = priorTransfer?.sentBlock != null;
    if (!sourceHasRun) {
      delta.tokenSymbol = mgr.tokenSymbol;
      delta.tokenAddress = mgr.tokenAddress;
      delta.tokenDecimals = mgr.tokenDecimals;
    }
  }

  // Defense-in-depth: MessageAttestedTo normally fires just before
  // TransferRedeemed in the same tx and drains the scratch itself. Skip
  // the walk when the detail row already carries `transceiverDigest` —
  // that's the happy-path signal MessageAttestedTo ran — otherwise (rare:
  // HyperSync drops the attest log, historical backfills) drain here too.
  const priorDetail = await (
    context as HandlerContext
  ).WormholeTransferDetail.get(id);
  const destPending = priorDetail?.transceiverDigest
    ? undefined
    : await drainDestPending(context as HandlerContext, event);
  const detailDelta: Record<string, unknown> = {};
  applyDestPendingToDelta(destPending, priorTransfer, delta, detailDelta);

  const transfer = await upsertTransferByDigest(
    context as HandlerContext,
    digest,
    ts,
    delta,
    detailDelta,
  );

  if (
    !alreadyDelivered &&
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

/**
 * Merge a drained `WormholeDestPending` payload into the transfer + detail
 * deltas a dest-side handler is about to upsert. No-op when `destPending`
 * is undefined. Preserves source identity that the source-side handler may
 * have already set — dest-side is secondary for that field.
 */
type DestPendingRow = NonNullable<
  Awaited<ReturnType<HandlerContext["WormholeDestPending"]["get"]>>
>;
function applyDestPendingToDelta(
  destPending: DestPendingRow | undefined,
  prior: { sourceChainId?: number; sourceContract?: string } | undefined,
  transferDelta: Record<string, unknown>,
  detailDelta: Record<string, unknown>,
): void {
  if (!destPending) return;
  if (prior?.sourceChainId == null)
    transferDelta.sourceChainId = destPending.sourceChainId;
  if (!prior?.sourceContract)
    transferDelta.sourceContract = destPending.sourceTransceiver;
  detailDelta.transceiverDigest = destPending.transceiverDigest;
  detailDelta.msgSequence = destPending.msgSequence;
  detailDelta.sourceWormholeChainId = destPending.sourceWormholeChainId;
}

/**
 * Drain the `WormholeDestPending` scratch written by the earlier-in-tx
 * ReceivedMessage. When a caller can identify the destination transceiver
 * (MessageAttestedTo carries it in `p.transceiver`), pass it as a filter so
 * multi-transceiver flows don't cross-pair. TransferRedeemed has no
 * transceiver identifier in its payload — it passes `undefined` and accepts
 * any scratch in the tx (safe because the drain races MessageAttestedTo,
 * which is authoritative when present).
 */
async function drainDestPending(
  context: HandlerContext,
  event: {
    chainId: number;
    transaction: { hash: string };
    logIndex: number;
  },
  transceiver?: string,
): Promise<
  Awaited<ReturnType<HandlerContext["WormholeDestPending"]["get"]>> | undefined
> {
  const transceiverLower = transceiver?.toLowerCase();
  return findAndDrainPendingScratch(
    context.WormholeDestPending,
    {
      chainId: event.chainId,
      txHash: event.transaction.hash,
      currentLogIndex: event.logIndex,
    },
    transceiverLower
      ? (row) => row.destTransceiver.toLowerCase() === transceiverLower
      : undefined,
  );
}

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
  // Idempotency: if the same event is replayed (restart, reorg), the
  // BridgeAttestation row's unique id guards the attestation table — but the
  // counter on BridgeTransfer would double-count. Probe first and skip the
  // counter bump when the attestation already exists.
  const existingAttestation = await (
    context as unknown as {
      BridgeAttestation: {
        get: (id: string) => Promise<BridgeAttestation | undefined>;
      };
    }
  ).BridgeAttestation.get(attestation.id);
  (context as HandlerContext).BridgeAttestation.set(attestation);
  if (existingAttestation) return;

  const prior = await (context as HandlerContext).BridgeTransfer.get(id);
  const count = (prior?.attestationCount ?? 0) + 1;
  // MessageAttestedTo fires on the destination chain — seed destChainId /
  // destContract when they haven't been set yet. Without this, a transfer
  // stuck at ATTESTED (rate-limit queue, failed delivery) permanently has
  // destChainId=null and drops out of any chain-filtered UI/query.
  const destDelta: Record<string, unknown> = {
    attestationCount: count,
    firstAttestedTimestamp: prior?.firstAttestedTimestamp ?? ts,
    lastAttestedTimestamp: ts,
  };
  if (prior?.destChainId == null) destDelta.destChainId = event.chainId;
  if (!prior?.destContract)
    destDelta.destContract = event.srcAddress.toLowerCase();

  // Drain the `WormholeDestPending` scratch written by the ReceivedMessage
  // that fired earlier in this same tx. It carries the source identity
  // (the transceiver-layer digest from ReceivedMessage cannot be used as
  // a BridgeTransfer key — it's a different hash from the manager digest).
  // Stamp the source identity onto the row being upserted here.
  const destPending = await drainDestPending(
    context as HandlerContext,
    event,
    p.transceiver,
  );
  const detailDelta: Record<string, unknown> = {};
  applyDestPendingToDelta(destPending, prior, destDelta, detailDelta);

  await upsertTransferByDigest(
    context as HandlerContext,
    p.digest,
    ts,
    destDelta,
    detailDelta,
  );
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
