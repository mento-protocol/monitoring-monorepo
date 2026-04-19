/**
 * Wormhole-specific status computer.
 *
 * Writes the generic `BridgeTransfer.status` field by reading both the generic
 * transfer fields and the Wormhole-specific detail fields. Ordered from latest
 * lifecycle stage backward — a fully delivered transfer has seen all prior
 * stages (rate-limit, queue, sent, attested); checking earlier stages first
 * would pin the status at an intermediate value.
 */
import type { BridgeTransfer, WormholeTransferDetail } from "generated";

export type BridgeStatus =
  | "PENDING"
  | "SENT"
  | "ATTESTED"
  | "DELIVERED"
  | "QUEUED_OUTBOUND"
  | "QUEUED_INBOUND"
  | "CANCELLED"
  | "FAILED";

export function computeWormholeStatus(
  t: Pick<
    BridgeTransfer,
    | "cancelledTimestamp"
    | "failedReason"
    | "deliveredBlock"
    | "attestationCount"
    | "sentBlock"
  >,
  d: Pick<
    WormholeTransferDetail,
    "inboundQueuedTimestamp" | "outboundQueuedSequence"
  > | null,
): BridgeStatus {
  if (t.cancelledTimestamp) return "CANCELLED";
  if (t.failedReason) return "FAILED";
  if (t.deliveredBlock) return "DELIVERED";
  if (t.attestationCount > 0) return "ATTESTED";
  if (d?.inboundQueuedTimestamp) return "QUEUED_INBOUND";
  if (t.sentBlock) return "SENT";
  if (d?.outboundQueuedSequence) return "QUEUED_OUTBOUND";
  return "PENDING";
}
