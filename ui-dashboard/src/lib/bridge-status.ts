import type { BridgeStatusOverlay, BridgeTransfer } from "./types";

const STUCK_THRESHOLD_SECONDS = 24 * 60 * 60;

/**
 * Derive the display status. Overlays "STUCK" when a SENT or ATTESTED transfer
 * hasn't been delivered within 24h. This is client-side so the "stuck" window
 * stays fresh without a bespoke indexer recompute.
 */
export function deriveBridgeStatus(
  transfer: Pick<BridgeTransfer, "status" | "sentTimestamp">,
  nowSeconds = Math.floor(Date.now() / 1000),
): BridgeStatusOverlay {
  const { status } = transfer;
  if (status !== "SENT" && status !== "ATTESTED") return status;
  const sentTs = transfer.sentTimestamp ? Number(transfer.sentTimestamp) : null;
  if (sentTs !== null && nowSeconds - sentTs > STUCK_THRESHOLD_SECONDS) {
    return "STUCK";
  }
  return status;
}

const STATUS_CLASSES: Record<BridgeStatusOverlay, string> = {
  PENDING: "bg-slate-800 text-slate-400",
  SENT: "bg-slate-800 text-slate-300",
  ATTESTED: "bg-indigo-900/40 text-indigo-300",
  DELIVERED: "bg-emerald-900/40 text-emerald-300",
  QUEUED_OUTBOUND: "bg-amber-900/40 text-amber-300",
  QUEUED_INBOUND: "bg-amber-900/40 text-amber-300",
  CANCELLED: "bg-slate-800 text-slate-500",
  FAILED: "bg-red-900/60 text-red-200",
  STUCK: "bg-red-900/40 text-red-300",
};

const STATUS_LABELS: Record<BridgeStatusOverlay, string> = {
  PENDING: "Pending",
  SENT: "Sent",
  ATTESTED: "Attested",
  DELIVERED: "Delivered",
  QUEUED_OUTBOUND: "Queued (out)",
  QUEUED_INBOUND: "Queued (in)",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  STUCK: "Stuck",
};

export function bridgeStatusClasses(status: BridgeStatusOverlay): string {
  return STATUS_CLASSES[status];
}

export function bridgeStatusLabel(status: BridgeStatusOverlay): string {
  return STATUS_LABELS[status];
}
