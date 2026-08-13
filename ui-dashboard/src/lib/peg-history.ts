export const PEG_HISTORY_RANGES = {
  "24h": { windowSeconds: 24 * 60 * 60, stepSeconds: 5 * 60 },
  "7d": { windowSeconds: 7 * 24 * 60 * 60, stepSeconds: 30 * 60 },
  "30d": { windowSeconds: 30 * 24 * 60 * 60, stepSeconds: 2 * 60 * 60 },
} as const;

export const PEG_HISTORY_RANGE_OPTIONS = ["24h", "7d", "30d"] as const;
export type PegHistoryRange = (typeof PEG_HISTORY_RANGE_OPTIONS)[number];

export type PegHistoryPoint = {
  /** Unix seconds. */
  at: number;
  /** Signed deviation from target; negative is below target. */
  bps: number;
  /** Alert name when a later feed attaches a state transition to this reading. */
  event?: string;
};

export type PegHistoryResponse = {
  asset: string;
  source: string;
  policyVersion: string;
  range: PegHistoryRange;
  from: number;
  to: number;
  stepSeconds: number;
  points: PegHistoryPoint[];
};
