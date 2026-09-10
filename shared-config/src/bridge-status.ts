import thresholds from "../bridge-thresholds.json" with { type: "json" };

/** Canonical seconds shared with Grafana rule generation. Queued NTT cannot bypass its 24h inbound window. */
export const BRIDGE_STUCK_THRESHOLD_SECONDS = thresholds;
export type BridgeInFlightStatus = keyof typeof thresholds;
export type BridgeStatus =
  | BridgeInFlightStatus
  | "DELIVERED"
  | "CANCELLED"
  | "FAILED";
export type BridgeStatusOverlay = BridgeStatus | "STUCK";
export interface BridgeProgression {
  status: BridgeStatus;
  sentTimestamp?: string | null | undefined;
  firstSeenAt?: string | null | undefined;
  lastUpdatedAt?: string | null | undefined;
  lastAttestedTimestamp?: string | null | undefined;
}

export function isBridgeInFlight(
  status: string,
): status is BridgeInFlightStatus {
  return (
    status === "PENDING" ||
    status === "SENT" ||
    status === "ATTESTED" ||
    status === "QUEUED_INBOUND"
  );
}

/** Zero and non-finite values mean unknown. Negative epochs remain usable for dashboard compatibility. */
function parseBridgeTimestamp(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const timestamp = Number(raw);
  return Number.isFinite(timestamp) && timestamp !== 0 ? timestamp : null;
}

/** Attestation wins over late source updates; destination-first rows fall back to firstSeenAt. */
export function bridgeProgressionTimestamp(
  transfer: BridgeProgression,
): number | null {
  const attested =
    transfer.status === "ATTESTED"
      ? parseBridgeTimestamp(transfer.lastAttestedTimestamp)
      : null;
  return (
    attested ??
    parseBridgeTimestamp(transfer.lastUpdatedAt) ??
    parseBridgeTimestamp(transfer.sentTimestamp) ??
    parseBridgeTimestamp(transfer.firstSeenAt)
  );
}

/** Unknown time stays null. Future times produce negative ages and do not imply stuck transfers. */
export function bridgeStateAgeSeconds(
  transfer: BridgeProgression,
  nowSeconds = Math.floor(Date.now() / 1000),
): number | null {
  const timestamp = bridgeProgressionTimestamp(transfer);
  return timestamp === null ? null : nowSeconds - timestamp;
}

export function deriveBridgeStatus(
  transfer: BridgeProgression,
  nowSeconds = Math.floor(Date.now() / 1000),
): BridgeStatusOverlay {
  const { status } = transfer;
  if (!isBridgeInFlight(status)) return status;
  const age = bridgeStateAgeSeconds(transfer, nowSeconds);
  return age !== null && age > BRIDGE_STUCK_THRESHOLD_SECONDS[status]
    ? "STUCK"
    : status;
}
