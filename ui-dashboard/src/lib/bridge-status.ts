import type {
  BridgeStatus,
  BridgeStatusOverlay,
  BridgeTransfer,
} from "./types";

const STUCK_THRESHOLD_SECONDS = 24 * 60 * 60;

/**
 * Canonical order for status-filter UI rendering. Ordered lifecycle-
 * ascending so the pills read as a pipeline (pre-flight → in-flight →
 * terminal). Kept in sync with the enum in indexer-envio/src/wormhole/
 * status.ts — missing any status from here silently drops it from the
 * filter UI.
 */
export const ALL_BRIDGE_STATUSES: readonly BridgeStatus[] = [
  "PENDING",
  "SENT",
  "ATTESTED",
  "QUEUED_INBOUND",
  "DELIVERED",
  "CANCELLED",
  "FAILED",
] as const;

/**
 * Derive the display status. Overlays "STUCK" when an in-flight transfer
 * (PENDING, SENT, ATTESTED, or QUEUED_INBOUND — any non-terminal state)
 * hasn't progressed within 24h. Client-side so the window stays fresh
 * without a bespoke indexer recompute.
 *
 * Age basis: prefer `sentTimestamp` when present; fall back to
 * `firstSeenAt`. PENDING rows created by a destination-first race have no
 * `sentTimestamp`, so using only that field would let them live
 * indefinitely as "Pending" even when the source side has clearly gone
 * missing — `firstSeenAt` is always populated and is the correct clock
 * for those rows.
 */
export function deriveBridgeStatus(
  transfer: Pick<BridgeTransfer, "status" | "sentTimestamp" | "firstSeenAt">,
  nowSeconds = Math.floor(Date.now() / 1000),
): BridgeStatusOverlay {
  const { status } = transfer;
  const inFlight =
    status === "PENDING" ||
    status === "SENT" ||
    status === "ATTESTED" ||
    status === "QUEUED_INBOUND";
  if (!inFlight) return status;
  const raw = transfer.sentTimestamp ?? transfer.firstSeenAt ?? null;
  const ts = raw == null ? null : Number(raw);
  if (ts === null || !Number.isFinite(ts)) return status;
  return nowSeconds - ts > STUCK_THRESHOLD_SECONDS ? "STUCK" : status;
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
 * Format a duration in seconds as a compact d/h/m/s string.
 * Normalizes to whole seconds once to avoid "60s" / "Nm 60s" artifacts at
 * unit boundaries (fractional averages can otherwise render 59.6s as "60s"
 * or 119.5s as "1m 60s").
 */
export function formatDurationShort(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Duration between source-send and destination-delivery, in seconds, or
 * `null` when either side is missing (not yet delivered, or race-window row
 * with no sentTimestamp). Returns 0 for a clock skew that produces
 * delivered < sent — the caller treats that as "just now".
 */
export function transferDeliveryDurationSec(
  t: Pick<BridgeTransfer, "sentTimestamp" | "deliveredTimestamp">,
): number | null {
  if (!t.sentTimestamp || !t.deliveredTimestamp) return null;
  const sent = Number(t.sentTimestamp);
  const delivered = Number(t.deliveredTimestamp);
  if (!Number.isFinite(sent) || !Number.isFinite(delivered)) return null;
  return Math.max(0, delivered - sent);
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
