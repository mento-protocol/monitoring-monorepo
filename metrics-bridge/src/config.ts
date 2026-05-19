import {
  DEVIATION_CRITICAL_RATIO,
  DEVIATION_TOLERANCE_RATIO,
} from "@mento-protocol/monitoring-config/thresholds";
import { env } from "./env.js";

export const HASURA_URL = env.HASURA_URL;
export const POLL_INTERVAL_MS = env.POLL_INTERVAL_MS;
export const PORT = env.PORT;

// Rebalance-reason probe runs every Nth Hasura poll cycle. The
// `Deviation Breach Critical` alert needs the breach to be sustained
// for >1h before firing, so a few-minute probe cadence is well inside the
// noise floor and keeps RPC load proportional to "pools currently in
// critical breach", typically 0–3 pools at Mento's scale.
export const REBALANCE_PROBE_EVERY_N_POLLS = Math.floor(
  env.REBALANCE_PROBE_EVERY_N_POLLS,
);

// Pools above tolerance whose current ratio or open-breach peak crossed this
// threshold are eligible for the rebalance-reason probe. Mirrors the
// `Deviation Breach Critical` rule so the annotation only attaches to alerts
// that can actually fire. Sourced from
// `@mento-protocol/monitoring-config/thresholds` so a future bump of the
// critical magnitude lands in one place across TS packages (the HCL literal in
// rules-fpmms.tf still has to be edited manually — see that file's comments).
export const REBALANCE_PROBE_DEVIATION_THRESHOLD = DEVIATION_CRITICAL_RATIO;
export const REBALANCE_PROBE_TOLERANCE_THRESHOLD = DEVIATION_TOLERANCE_RATIO;

// Legacy open-breach rows can have `currentOpenBreachEntryThreshold = 0`
// because the column was added after the breach opened. The indexer closes
// those rows against the same 10000 effective-threshold floor; metrics-bridge
// uses it too so sticky critical alerting still works for old open breaches.
export const LEGACY_OPEN_BREACH_ENTRY_THRESHOLD = 10_000;

// Cap simultaneous probe RPC calls so a stuck endpoint can't backpressure
// the next Hasura poll. At Mento's scale 0–3 pools are typically eligible
// per cycle, so 5 leaves headroom without being permissive.
export const REBALANCE_PROBE_CONCURRENCY = Math.floor(
  env.REBALANCE_PROBE_CONCURRENCY,
);

// Per-RPC-call timeout. Forno + monad public RPCs respond in <1s on the
// happy path; 8s gives transient slow paths room without blocking the
// next cycle. Matches the existing 8s SWR timeout pattern in the dashboard.
export const REBALANCE_PROBE_TIMEOUT_MS = Math.floor(
  env.REBALANCE_PROBE_TIMEOUT_MS,
);
