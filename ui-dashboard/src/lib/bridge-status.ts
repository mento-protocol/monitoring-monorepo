import type {
  BridgeStatus,
  BridgeStatusOverlay,
  BridgeTransfer,
} from "./types";

const STUCK_THRESHOLD_SECONDS = 24 * 60 * 60;

/**
 * Canonical order for status-filter UI rendering. Ordered lifecycle-
 * ascending so the pills read as a pipeline (pre-flight → in-flight →
 * terminal).
 *
 * The union `BridgeStatus` describes the full schema vocabulary (including
 * CANCELLED / FAILED, which are reserved for post-v1 event wiring). This
 * list is the *user-filterable* subset — the statuses the indexer actually
 * writes today. The Wormhole status computer in
 * `indexer-envio/src/wormhole/status.ts` documents that no handler writes
 * `cancelledTimestamp` or `failedReason` in v1, so exposing those pills
 * would let the user filter to a set that's always empty.
 *
 * The `satisfies readonly BridgeStatus[]` clause enforces each entry is a
 * valid `BridgeStatus` so a typo in the literal is caught at compile time,
 * but the list is intentionally *not* computed from the union — the whole
 * point is to force a conscious update when a new status is wired.
 */
export const ALL_BRIDGE_STATUSES = [
  "PENDING",
  "SENT",
  "ATTESTED",
  "QUEUED_INBOUND",
  "DELIVERED",
] as const satisfies readonly BridgeStatus[];

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
  // Wormholescan shades the three in-flight sub-states the same way — one
  // "in progress" look so operators don't have to map indexer vocabulary
  // (SENT / ATTESTED / QUEUED_INBOUND) onto Wormhole's single label.
  SENT: "bg-indigo-900/40 text-indigo-300",
  ATTESTED: "bg-indigo-900/40 text-indigo-300",
  QUEUED_INBOUND: "bg-indigo-900/40 text-indigo-300",
  DELIVERED: "bg-emerald-900/40 text-emerald-300",
  CANCELLED: "bg-slate-800 text-slate-500",
  FAILED: "bg-red-900/60 text-red-200",
  STUCK: "bg-red-900/40 text-red-300",
};

// Display label in the transfers table. SENT / ATTESTED / QUEUED_INBOUND all
// surface as "In progress" to match Wormholescan, which collapses the same
// lifecycle into one label. Filter pills use `bridgeStatusDetailLabel` below
// to keep their internal-state granularity.
const STATUS_LABELS: Record<BridgeStatusOverlay, string> = {
  PENDING: "Pending",
  SENT: "In progress",
  ATTESTED: "In progress",
  QUEUED_INBOUND: "In progress",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  STUCK: "Stuck",
};

// Granular label used by the status filter pills, where conflating the three
// in-flight sub-states would leave the user unable to distinguish them.
const STATUS_DETAIL_LABELS: Record<BridgeStatusOverlay, string> = {
  PENDING: "Pending",
  SENT: "Sent",
  ATTESTED: "Attested",
  QUEUED_INBOUND: "Queued",
  DELIVERED: "Delivered",
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

export function bridgeStatusDetailLabel(status: BridgeStatusOverlay): string {
  return STATUS_DETAIL_LABELS[status];
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
 * Parse a human duration string into seconds. Accepts the shapes operators
 * actually type when filtering tables: `1h`, `10m`, `3d`, `90s`, bare
 * integers (treated as seconds), and multi-unit runs like `1h30m` or
 * `1d 6h`. Also accepts singular/plural word forms: `3 days`, `2 hours`,
 * `30 mins`, `1 week`. Returns `null` for empty strings or anything that
 * doesn't cleanly parse — the caller renders an inline error.
 *
 * Intentionally does NOT handle months/years: breach durations top out in
 * weeks and "1mo" is ambiguous (minutes? months?).
 */
export function parseDurationSeconds(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed));
  const unitSeconds: Record<string, number> = {
    s: 1,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hrs: 3600,
    hour: 3600,
    hours: 3600,
    d: 86_400,
    day: 86_400,
    days: 86_400,
    w: 604_800,
    wk: 604_800,
    wks: 604_800,
    week: 604_800,
    weeks: 604_800,
  };
  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = false;
  for (const m of trimmed.matchAll(pattern)) {
    const [, num, unit] = m;
    const factor = unitSeconds[unit];
    if (factor == null) return null;
    total += Number(num) * factor;
    matched = true;
  }
  if (!matched) return null;
  // Reject trailing junk like "1h banana" or "1h 2x"
  const stripped = trimmed.replace(pattern, "").replace(/[\s,]+/g, "");
  if (stripped.length > 0) return null;
  return Math.round(total);
}

/**
 * Duration between source-send and destination-delivery, in seconds, or
 * `null` when either side is missing (not yet delivered, race-window row
 * with no sentTimestamp, or a sentinel "0" that an indexer may have
 * written before the real source event was observed). Returns 0 for a
 * clock skew that produces delivered < sent — the caller treats that as
 * "just now". Non-finite strings (e.g. "abc") also return null.
 */
export function transferDeliveryDurationSec(
  t: Pick<BridgeTransfer, "sentTimestamp" | "deliveredTimestamp">,
): number | null {
  if (!t.sentTimestamp || !t.deliveredTimestamp) return null;
  const sent = Number(t.sentTimestamp);
  const delivered = Number(t.deliveredTimestamp);
  if (!Number.isFinite(sent) || !Number.isFinite(delivered)) return null;
  // Epoch sentinel: treat a literal "0" as "not yet known" rather than
  // producing a 5-decade delivery delta. Negative values (e.g. a bogus
  // clock-skewed timestamp < 0) fall through to the Math.max clamp.
  if (sent === 0 || delivered === 0) return null;
  return Math.max(0, delivered - sent);
}
