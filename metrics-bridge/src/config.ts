import { DEVIATION_CRITICAL_RATIO } from "@mento-protocol/monitoring-config/thresholds";

const DEFAULT_HASURA_URL = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql";

export const HASURA_URL = process.env.HASURA_URL || DEFAULT_HASURA_URL;

const rawPollInterval = Number(process.env.POLL_INTERVAL_MS || "30000");
export const POLL_INTERVAL_MS =
  Number.isFinite(rawPollInterval) && rawPollInterval >= 1000
    ? rawPollInterval
    : 30000;

const rawPort = Number(process.env.PORT || "8080");
export const PORT =
  Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8080;

// Rebalance-reason probe runs every Nth Hasura poll cycle. The
// `Deviation Breach Critical` alert needs the breach to be sustained
// for >1h before firing, so a few-minute probe cadence is well inside the
// noise floor and keeps RPC load proportional to "pools currently in
// critical breach", typically 0–3 pools at Mento's scale.
const rawRebalanceProbeEvery = Number(
  process.env.REBALANCE_PROBE_EVERY_N_POLLS || "5",
);
export const REBALANCE_PROBE_EVERY_N_POLLS =
  Number.isFinite(rawRebalanceProbeEvery) && rawRebalanceProbeEvery >= 1
    ? Math.floor(rawRebalanceProbeEvery)
    : 5;

// Pools with a deviation ratio strictly above this threshold are eligible
// for the rebalance-reason probe. Mirrors the `> 1.05` gate on the
// `Deviation Breach Critical` rule (terraform/alerts/rules-fpmms.tf:470)
// so the annotation only attaches to alerts that can actually fire. Sourced
// from `@mento-protocol/monitoring-config/thresholds` so a future bump of the
// critical magnitude lands in one place across TS packages (the HCL literal in
// rules-fpmms.tf still has to be edited manually — see that file's comments).
export const REBALANCE_PROBE_DEVIATION_THRESHOLD = DEVIATION_CRITICAL_RATIO;

// Cap simultaneous probe RPC calls so a stuck endpoint can't backpressure
// the next Hasura poll. At Mento's scale 0–3 pools are typically eligible
// per cycle, so 5 leaves headroom without being permissive.
const rawProbeConcurrency = Number(
  process.env.REBALANCE_PROBE_CONCURRENCY || "5",
);
export const REBALANCE_PROBE_CONCURRENCY =
  Number.isFinite(rawProbeConcurrency) && rawProbeConcurrency >= 1
    ? Math.floor(rawProbeConcurrency)
    : 5;

// Per-RPC-call timeout. Forno + monad public RPCs respond in <1s on the
// happy path; 8s gives transient slow paths room without blocking the
// next cycle. Matches the existing 8s SWR timeout pattern in the dashboard.
const rawProbeTimeout = Number(
  process.env.REBALANCE_PROBE_TIMEOUT_MS || "8000",
);
export const REBALANCE_PROBE_TIMEOUT_MS =
  Number.isFinite(rawProbeTimeout) && rawProbeTimeout >= 1000
    ? Math.floor(rawProbeTimeout)
    : 8000;
