// Fixed independent cadence; exported alongside the snapshot so alert freshness
// follows the actual runtime rather than a separately hard-coded rule value.
export const BRIDGE_POLL_INTERVAL_MS = 30_000;
export const BRIDGE_OBSERVATION_TIMEOUT_MS = 15_000;
export const BRIDGE_FRESHNESS_SECONDS =
  (BRIDGE_POLL_INTERVAL_MS + BRIDGE_OBSERVATION_TIMEOUT_MS) / 1000;
export const BRIDGE_PAGE_SIZE = 500;
export const BRIDGE_MAX_PAGES = 20;
export const BRIDGE_MAX_ROWS = 10_000;
export const BRIDGE_CHAIN_LABELS = ["137", "143", "42220", "unknown"] as const;
export const BRIDGE_TOKEN_LABELS = ["USDm", "EURm", "unknown"] as const;
