/**
 * Wormhole Transceiver event handler.
 *
 * `ReceivedMessage(digest, emitterChainId, emitterAddress, sequence)` fires
 * on the destination chain when a VAA arrives at our transceiver proxy.
 *
 * IMPORTANT: the `digest` emitted here is the TRANSCEIVER-LAYER digest
 * (`TransceiverStructs.transceiverMessageDigest`). It is a DIFFERENT
 * bytestring from the NTT MANAGER-LAYER digest emitted by TransferSent,
 * MessageAttestedTo, and TransferRedeemed on the NttManager. The two
 * digests hash different parts of the same NTT message (outer transceiver
 * wrapping vs inner manager payload), so treating them as interchangeable
 * produces orphan BridgeTransfer rows keyed by the wrong digest.
 *
 * This handler therefore does NOT create or mutate a BridgeTransfer /
 * WormholeTransferDetail keyed by `digest`. Instead it writes a scratch
 * `WormholeDestPending` row keyed by `(chainId, txHash, logIndex)`. The
 * matching `MessageAttestedTo` handler (and `TransferRedeemed` fallback)
 * fire in the same tx at higher logIndex, walk backward to find the
 * scratch, and stamp the source identity + transceiverDigest onto the
 * BridgeTransfer/detail keyed by the authoritative manager digest.
 */
import { WormholeTransceiver } from "generated";
import { bytes32ToAddress } from "../../wormhole/detail";
import { wormholeToEvmChainId } from "../../wormhole/chainIds";

// Narrow structural type — only the entity accessor we use here. Mirrors the
// pattern in src/handlers/wormhole/nttManager.ts which also defines its own
// HandlerContext shape rather than pulling the wide generated type.
type HandlerContext = {
  WormholeDestPending: {
    set: (entity: {
      id: string;
      chainId: number;
      txHash: string;
      transceiverDigest: string;
      sourceChainId: number;
      sourceTransceiver: string;
      sourceWormholeChainId: number;
      msgSequence: bigint;
      destTransceiver: string;
      blockTimestamp: bigint;
    }) => void;
  };
};

WormholeTransceiver.ReceivedMessage.handler(async ({ event, context }) => {
  const p = event.params;
  const emitterChainId = Number(p.emitterChainId);
  const sourceEvm = wormholeToEvmChainId(emitterChainId);
  // If we can't map the Wormhole chain id to an EVM chain we index, the
  // scratch would never be drained by a MessageAttestedTo we emit (different
  // peer). Skip — leaves no state behind.
  if (sourceEvm === null) return;

  const pendingId = `${event.chainId}-${event.transaction.hash.toLowerCase()}-${event.logIndex}`;
  (context as HandlerContext).WormholeDestPending.set({
    id: pendingId,
    chainId: event.chainId,
    txHash: event.transaction.hash,
    transceiverDigest: p.digest.toLowerCase(),
    sourceChainId: sourceEvm,
    sourceTransceiver: bytes32ToAddress(p.emitterAddress),
    sourceWormholeChainId: emitterChainId,
    msgSequence: p.sequence,
    destTransceiver: event.srcAddress.toLowerCase(),
    blockTimestamp: BigInt(event.block.timestamp),
  });
});
