/**
 * Wormhole Transceiver event handler.
 *
 * `ReceivedMessage` fires on the destination chain when a message arrives via
 * the Wormhole network (before TransferRedeemed is called on the manager).
 * It gives us the source-side identity for a digest — useful for enriching
 * BridgeTransfer when the destination event arrives before the source event
 * (dest-first race under unordered_multichain_mode).
 */
import { WormholeTransceiver } from "generated";
import type { BridgeTransfer, WormholeTransferDetail } from "generated";
import {
  buildTransferId,
  bytes32ToAddress,
  defaultBridgeTransfer,
} from "../../bridge";
import { computeWormholeStatus } from "../../wormhole/status";
import { wormholeToEvmChainId } from "../../wormhole/chainIds";

const PROVIDER = "WORMHOLE" as const;

WormholeTransceiver.ReceivedMessage.handler(async ({ event, context }) => {
  const p = event.params;
  const ts = BigInt(event.block.timestamp);
  const id = buildTransferId(PROVIDER, p.digest);

  const priorTransfer =
    (await context.BridgeTransfer.get(id)) ??
    defaultBridgeTransfer({
      id,
      provider: PROVIDER,
      providerMessageId: p.digest,
      blockTimestamp: ts,
    });
  const priorDetail = (await context.WormholeTransferDetail.get(id)) ?? {
    id,
    digest: p.digest.toLowerCase(),
    msgSequence: undefined,
    sourceWormholeChainId: undefined,
    destWormholeChainId: undefined,
    refundAddress: undefined,
    fee: undefined,
    outboundQueuedSequence: undefined,
    inboundQueuedTimestamp: undefined,
    rateLimitedCurrentCapacity: undefined,
  };

  const emitterChainId = Number(p.emitterChainId);
  const sourceEvm = wormholeToEvmChainId(emitterChainId);
  const nextDetail: WormholeTransferDetail = {
    ...priorDetail,
    sourceWormholeChainId: priorDetail.sourceWormholeChainId ?? emitterChainId,
    msgSequence: priorDetail.msgSequence ?? p.sequence,
  };

  const merged = {
    ...priorTransfer,
    sourceChainId:
      priorTransfer.sourceChainId ??
      (sourceEvm === null ? undefined : sourceEvm),
    sourceContract:
      priorTransfer.sourceContract ?? bytes32ToAddress(p.emitterAddress),
    lastUpdatedAt: ts,
  };
  const nextTransfer: BridgeTransfer = {
    ...merged,
    status: computeWormholeStatus(merged as BridgeTransfer, nextDetail),
  } as BridgeTransfer;

  context.BridgeTransfer.set(nextTransfer);
  context.WormholeTransferDetail.set(nextDetail);
});
