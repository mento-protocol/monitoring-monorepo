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
  QUEUED_INBOUND: "Queued",
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

/**
 * Format a duration in seconds as a compact h/m/s string.
 * Normalizes to whole seconds once to avoid "60s" / "Nm 60s" artifacts at
 * unit boundaries (fractional averages can otherwise render 59.6s as "60s"
 * or 119.5s as "1m 60s").
 */
export function formatDurationShort(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Compute average delivery time (in seconds) across DELIVERED transfers,
 * excluding any row missing `sentTimestamp` (can happen when the
 * destination event arrives before the source has been indexed).
 *
 * Returns `{ avgSec: null, sampleSize: 0 }` if no usable rows.
 */
export function computeAvgDeliverTime(
  transfers: ReadonlyArray<
    Pick<BridgeTransfer, "status" | "sentTimestamp" | "deliveredTimestamp">
  >,
): { avgSec: number | null; sampleSize: number } {
  const usable = transfers.filter(
    (t) => t.status === "DELIVERED" && t.deliveredTimestamp && t.sentTimestamp,
  );
  if (usable.length === 0) return { avgSec: null, sampleSize: 0 };
  const total = usable.reduce((acc, t) => {
    const sent = Number(t.sentTimestamp);
    const delivered = Number(t.deliveredTimestamp);
    return acc + Math.max(0, delivered - sent);
  }, 0);
  return { avgSec: total / usable.length, sampleSize: usable.length };
}
