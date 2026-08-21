export const PEG_ALERTS_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const PEG_ALERTS_REFRESH_MS = 5 * 60 * 1_000;

export type PegAlertSeverity = "warning" | "cleared" | "page";

export const PEG_ALERT_RULE_KINDS = [
  "Blind Warning",
  "Blind While Stressed Critical",
  "Critical Path Unreachable",
  "Deep-Venue Downside Critical",
  "Deep-Venue Spread Warning",
  "Downside Warning",
  "Heartbeat Missing",
  "Indexed Pool Unreachable",
  "Policy Rollover Stuck",
  "Premium Warning",
  "Registry Rot",
  "Source Permanently Dead",
  "Source Unhealthy",
  "Structural Saturation Warning",
] as const;

export type PegAlertRuleKind =
  | (typeof PEG_ALERT_RULE_KINDS)[number]
  | "Unknown";

type PegAlertEvidence = {
  rule: PegAlertRuleKind;
  assetId: string;
  assetName: string;
  sourceId: string;
  sourceName: string;
  quoteCurrency: string | null;
  policyVersion: string;
  failureReason: number | null;
  evaluationState?:
    | "failed"
    | "recovered"
    | "recovered-alerting"
    | "recovered-pending";
};

export type PegAlertEvent = {
  id: string;
  /** Unix seconds. */
  at: number;
  severity: PegAlertSeverity;
  /** Bold cause-first lead-in, e.g. "Bitvavo sell price is 30 bps below peg". */
  lead: string;
  detail: string;
  /** Bounded context for the fixed product explanation shown on disclosure. */
  evidence: PegAlertEvidence;
};

export type PegAlertsResponse = {
  /** Unix seconds. */
  from: number;
  /** Unix seconds. */
  to: number;
  events: PegAlertEvent[];
};
