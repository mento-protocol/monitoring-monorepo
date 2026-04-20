/**
 * Wormhole-specific status computer.
 *
 * Writes the generic `BridgeTransfer.status` field by reading the generic
 * transfer fields and (only for QUEUED_INBOUND) the Wormhole-specific detail.
 * Ordered from latest lifecycle stage backward — a fully delivered transfer
 * has seen all prior stages; checking earlier stages first would pin the
 * status at an intermediate value.
 *
 * Source-side queue/rate-limit events are not indexed (they carry only a
 * sequence, not a digest — see config.multichain.mainnet.yaml). QUEUED_OUTBOUND
 * is intentionally absent from the enum until that correlation is built.
 */
import type { BridgeTransfer, WormholeTransferDetail } from "generated";

export type BridgeStatus =
  | "PENDING"
  | "SENT"
  | "ATTESTED"
  | "DELIVERED"
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
  d: Pick<WormholeTransferDetail, "inboundQueuedTimestamp"> | null,
): BridgeStatus {
  // CANCELLED / FAILED are reserved in the enum but no handler writes
  // `cancelledTimestamp` or `failedReason` in v1 — these branches only fire
  // once a cancel/fail event is wired (Wormhole NTT has no cancel event on
  // the source side today; FAILED would come from a failed-redeem event we
  // don't yet index). Remove the branches when wiring them if unused at
  // that point; leave in place so we don't have to diff reviewers' mental
  // models of the status machine.
  if (t.cancelledTimestamp) return "CANCELLED";
  if (t.failedReason) return "FAILED";
  if (t.deliveredBlock) return "DELIVERED";
  // QUEUED_INBOUND must win over ATTESTED: `MessageAttestedTo` fires on dest
  // before `InboundTransferQueued`, so a rate-limited inbound transfer always
  // has attestationCount > 0 by the time it's queued. Ordering ATTESTED first
  // would make the queue state unreachable.
  if (d?.inboundQueuedTimestamp) return "QUEUED_INBOUND";
  if (t.attestationCount > 0) return "ATTESTED";
  if (t.sentBlock) return "SENT";
  return "PENDING";
}
