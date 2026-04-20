/**
 * Wormhole-specific pure helpers: bytes32-address decoding and the default
 * shape of the WormholeTransferDetail scratch row.
 *
 * Lives outside src/bridge.ts because neither is generic — both are coupled
 * to the Wormhole NTT message format.
 */
import type { WormholeTransferDetail } from "generated";

const ADDRESS_ZERO_PADDING = "0".repeat(24);

/**
 * Decode a Wormhole-style bytes32 recipient to an EVM address. Returns the
 * raw bytes32 (lowercase) when upper 12 bytes are non-zero — indicating a
 * non-EVM recipient (e.g., Solana).
 */
export function bytes32ToAddress(b32: string): string {
  const hex = b32.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 64) return b32.toLowerCase();
  const upper = hex.slice(0, 24);
  const lower = hex.slice(24);
  if (upper !== ADDRESS_ZERO_PADDING) return `0x${hex}`;
  return `0x${lower}`;
}

/**
 * Default-fill a WormholeTransferDetail row when first created by any handler.
 *
 * `digest` is the NTT manager-layer digest (TransferSent/MessageAttestedTo/
 * TransferRedeemed) and matches `BridgeTransfer.id`'s suffix. The transceiver-
 * layer digest that ReceivedMessage emits goes into `transceiverDigest` and is
 * stamped on later when the dest-side scratch is drained.
 */
export function defaultWormholeDetail(
  id: string,
  digest: string,
): WormholeTransferDetail {
  return {
    id,
    digest: digest.toLowerCase(),
    transceiverDigest: undefined,
    msgSequence: undefined,
    sourceWormholeChainId: undefined,
    destWormholeChainId: undefined,
    refundAddress: undefined,
    fee: undefined,
    inboundQueuedTimestamp: undefined,
  };
}
