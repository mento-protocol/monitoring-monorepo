export const PEG_ALERTS_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const PEG_ALERTS_REFRESH_MS = 5 * 60 * 1_000;

export type PegAlertSeverity = "warning" | "cleared" | "page";

export type PegAlertEvent = {
  id: string;
  /** Unix seconds. */
  at: number;
  severity: PegAlertSeverity;
  /** Bold cause-first lead-in, e.g. "Bitvavo sell price is 30 bps below peg". */
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
