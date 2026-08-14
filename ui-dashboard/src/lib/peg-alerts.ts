export const PEG_ALERTS_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const PEG_ALERTS_REFRESH_MS = 5 * 60 * 1_000;

export type PegAlertSeverity = "warning" | "cleared" | "page" | "policy";

export type PegAlertEvent = {
  id: string;
  /** Unix seconds. */
  at: number;
  severity: PegAlertSeverity;
  /** Bold lead-in, e.g. "EUROP spread warning cleared". */
  lead: string;
  detail: string;
};

export type PegAlertsResponse = {
  /** Unix seconds. */
  from: number;
  /** Unix seconds. */
  to: number;
  events: PegAlertEvent[];
};
