import { Gauge, Counter, Registry } from "prom-client";
import {
  chainSlug,
  explorerAddressUrl,
  explorerTxUrl,
  hasChain,
} from "@mento-protocol/monitoring-config/chains";
import {
  poolName,
  tokenSymbol,
} from "@mento-protocol/monitoring-config/tokens";
import {
  poolIdAddress,
  shortAddress,
} from "@mento-protocol/monitoring-config/format";
import { toHumanUnits } from "@mento-protocol/monitoring-config/units";
import { LEGACY_OPEN_BREACH_ENTRY_THRESHOLD } from "./config.js";
import {
  observeDeviationAlertState,
  pruneDeviationAlertStates,
} from "./deviation-alert-state.js";
import type { PoolRow } from "./types.js";

// SortedOracles fixed-point scale — keep in sync with
// `indexer-envio/src/priceDifference.ts:SORTED_ORACLES_DECIMALS` and the
// dashboard's `ui-dashboard/src/lib/format.ts`. The contract reports rates
// in FixidityLib units, so the bridge gauge has to divide by 10^24 before
// it leaves the bridge for the alert template / dashboard tooltip to read
// directly.
const SORTED_ORACLES_DECIMALS = 24;

// Pools we've already warned about — prevents log spam on the 30s poll loop.
const warnedUnknownPools = new Set<string>();

// PR #209 safety net — warn once per pool when any display label falls back,
// so a missing chain/token in shared-config or @mento-protocol/contracts
// doesn't silently ship degraded Slack alerts.
function warnIfUnknown(pool: PoolRow, pair: string | null): void {
  if (warnedUnknownPools.has(pool.id)) return;
  const missing: string[] = [];
  if (pair === null) {
    // Include token addresses so on-call can jump straight to @mento-protocol/contracts
    // without looking up the pool row in Hasura first.
    missing.push(
      `pair (token0=${pool.token0 ?? "null"}, token1=${pool.token1 ?? "null"})`,
    );
  }
  if (!hasChain(pool.chainId)) missing.push("chain_name", "block_explorer_url");
  if (missing.length === 0) return;
  warnedUnknownPools.add(pool.id);
  console.warn(
    `[metrics-bridge] pool ${pool.id} (chain ${pool.chainId}) missing ${missing.join(", ")} — falling back. Add the chain to shared-config/chain-metadata.json, or the token to @mento-protocol/contracts.`,
  );
}

export function healthStatusToNumber(status: string): number {
  switch (status) {
    case "OK":
      return 0;
    case "WARN":
      return 1;
    case "CRITICAL":
      return 2;
    default:
      return 3;
  }
}

const fp = (s: string) => parseFloat(s);

export const register = new Registry();

// Display-oriented labels are carried on every pool-scoped series so Slack
// alert templates can render a readable title + deep-links to the block
// explorer and dashboard without needing a PromQL join against an info metric.
// Cardinality is bounded by the number of pools (each label is 1:1 with
// pool_id), so adding them doesn't create new series — only widens them.
const poolLabels = [
  "pool_id",
  "chain_id",
  "chain_name",
  "pair",
  "pool_address_short",
  "block_explorer_url",
] as const;
// Issue #698 deliberately carries the last oracle tx URL on timestamp/expiry
// gauges so Grafana annotations can link the Slack "last update" text. Keep
// this scoped to oracle liveness gauges; do not add it to every pool series.
const oracleUpdateLabels = [...poolLabels, "last_oracle_update_url"] as const;
const deviationAlertStateLabels = [...poolLabels, "state"] as const;
const deviationAlertTransitionCounterLabels = [
  ...poolLabels,
  "from",
  "to",
  "reason",
] as const;
const deviationAlertTransitionActiveLabels = [
  ...deviationAlertTransitionCounterLabels,
  "breach_started_at",
  "breach_ended_at",
  "breach_duration",
] as const;
const pressureLabels = [...poolLabels, "token_index"] as const;
// Reserve-share gauges carry an additional `token_symbol` label so the Slack
// alert annotation can render "17% USDT / 83% USDm" without parsing the `pair`
// label (sprig `splitList` is NOT in scope for Grafana annotation templates —
// only Go text/template builtins + Prometheus helpers like
// `humanizePercentage` are. Label access via `$values.X.Labels.Y` is a Go
// template builtin, so this is safe).
const reserveShareLabels = [...poolLabels, "token_symbol"] as const;
// `reason_code` and `reason_message` are bounded by the ERROR_MESSAGES enum
// (~30 codes) and one-to-one with each other — carrying both as labels
// lets the Slack alert template render the human-readable explanation and
// decoded contract error code without a sprig lookup table that has to stay in
// sync with the strategy ABI. The annotation cross-references this gauge's
// labels via `$values.B.Labels.{reason_message,reason_code}`: Grafana's
// `$labels` exposes only the firing-query labels (the breach gauge), so the
// alert template walks query B's series through the `$values` map.
// `decodeBlockedRevert` guarantees both labels stay inside the bounded enum
// even on `Error(string)` / `Panic(uint256)` reverts (raw payload goes to
// the `diagnostic` log channel) so cardinality stays bounded.
const rebalanceBlockedLabels = [
  ...poolLabels,
  "reason_code",
  "reason_message",
] as const;
export type PollErrorKind =
  | "hasura_query"
  | "update_metrics"
  | "mark_healthy"
  | "rebalance_probe";
const pollErrorLabels = ["kind"] as const;

export const gauges = {
  oracleOk: new Gauge({
    name: "mento_pool_oracle_ok",
    help: "Oracle can-trade flag at last on-chain event (1=ok, 0=not ok). For live staleness, use (time() - oracle_timestamp) / oracle_expiry in PromQL.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleTimestamp: new Gauge({
    name: "mento_pool_oracle_timestamp",
    help: "Unix timestamp of the last oracle report. Use with oracle_expiry to compute live liveness ratio.",
    labelNames: oracleUpdateLabels,
    registers: [register],
  }),
  oracleExpiry: new Gauge({
    name: "mento_pool_oracle_expiry",
    help: "Oracle report expiry window in seconds",
    labelNames: oracleUpdateLabels,
    registers: [register],
  }),
  deviationRatio: new Gauge({
    name: "mento_pool_deviation_ratio",
    help: "Deviation ratio (priceDifference / rebalanceThreshold)",
    labelNames: poolLabels,
    registers: [register],
  }),
  deviationBreachStart: new Gauge({
    name: "mento_pool_deviation_breach_start",
    help: "Unix timestamp when deviation breach started (0 = no breach)",
    labelNames: poolLabels,
    registers: [register],
  }),
  deviationOpenBreachPeakRatio: new Gauge({
    name: "mento_pool_deviation_open_breach_peak_ratio",
    help: "Peak deviation ratio observed during the currently open breach (currentOpenBreachPeak / currentOpenBreachEntryThreshold). Absent when there is no open breach or the entry threshold is unavailable.",
    labelNames: poolLabels,
    registers: [register],
  }),
  deviationAlertState: new Gauge({
    name: "mento_pool_deviation_alert_state",
    help: "Current metrics-bridge deviation alert state for a pool. Exactly one state label is set to 1 per pool on each successful poll.",
    labelNames: deviationAlertStateLabels,
    registers: [register],
  }),
  deviationAlertTransitionActive: new Gauge({
    name: "mento_pool_deviation_alert_transition_active",
    help: "Short-lived deviation alert state transition marker for Slack notifications. Labels carry the exact reason plus pre-rendered UTC start/end/duration strings.",
    labelNames: deviationAlertTransitionActiveLabels,
    registers: [register],
  }),
  limitPressure: new Gauge({
    name: "mento_pool_limit_pressure",
    help: "Trading limit pressure per token direction",
    labelNames: pressureLabels,
    registers: [register],
  }),
  // Flat per-token reserve-share gauges. Split from a single
  // `mento_pool_reserve_share{token_index}` (PR #234 review) because
  // Grafana per-instance label match (`$values.R0` / `$values.R1` against
  // a firing alert keyed on `pool_id, chain_id, pair`) silently fails
  // when the annotation query carries an extra dimension that's not in
  // the firing fingerprint. The pool-fingerprint subset of labels MUST
  // match the deviation-ratio gauge's exactly so the `current_reserves`
  // annotation actually renders. The `token_symbol` extension carries
  // axlUSDC / USDm into the Slack alert without forcing the annotation
  // template to parse the `pair` label (which would require sprig
  // `splitList`, NOT in scope for Grafana annotation templates).
  reserveShareToken0: new Gauge({
    name: "mento_pool_reserve_share_token0",
    help: "Share of normalized reserves held in token0 (decimal-adjusted, no oracle conversion). r0_normalized / (r0_normalized + r1_normalized) ∈ [0, 1]. Skipped when both reserves are zero (share undefined); emits 1.0 / 0.0 for one-sided pools to preserve the diagnostic '100% USDT / 0% USDm' signal. Carries a `token_symbol` label (axlUSDC, USDm, …) so Slack alerts can name the imbalance without parsing the `pair` label.",
    labelNames: reserveShareLabels,
    registers: [register],
  }),
  reserveShareToken1: new Gauge({
    name: "mento_pool_reserve_share_token1",
    help: "Share of normalized reserves held in token1 (decimal-adjusted, no oracle conversion). r1_normalized / (r0_normalized + r1_normalized) ∈ [0, 1]. Skipped when both reserves are zero; emits 1.0 / 0.0 for one-sided pools (mirror of reserve_share_token0). Carries a `token_symbol` label.",
    labelNames: reserveShareLabels,
    registers: [register],
  }),
  lastRebalancedAt: new Gauge({
    name: "mento_pool_last_rebalanced_at",
    help: "Unix timestamp of the last rebalance",
    labelNames: poolLabels,
    registers: [register],
  }),
  rebalanceEffectiveness: new Gauge({
    name: "mento_pool_rebalance_effectiveness",
    help: "Last observed rebalance effectiveness ratio: (priceDiff_before - priceDiff_after) / (priceDiff_before - rebalanceThreshold). 1.0 = rebalance landed exactly on the rebalance boundary (ideal); >1.0 = overshoot past the boundary (e.g. all the way to the oracle, which is over-correction); 0 = no reduction; <0 = rebalance made deviation WORSE. -1 indexer sentinel (degenerate case — zero pre-deviation, missing threshold, or pool was already in-band) is skipped.",
    labelNames: poolLabels,
    registers: [register],
  }),
  swapFeeBps: new Gauge({
    name: "mento_pool_swap_fee_bps",
    help: "Combined swap fee (lpFee + protocolFee) in basis points. Used as the threshold for the Oracle Jump alert. Skipped when either fee is the -1 indexer sentinel (fetch failed at pool creation).",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleJumpBps: new Gauge({
    name: "mento_pool_oracle_jump_bps",
    help: "|newMedian − prevMedian| / prevMedian × 10_000 for the most recent MedianUpdated event, in basis points (4dp fixed-point). 0 before the second median on a feed.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleJumpAt: new Gauge({
    name: "mento_pool_oracle_jump_at",
    help: "Unix timestamp of the MedianUpdated event that produced oracle_jump_bps. 0 before the first median. Alerts gate on (time() - this) to avoid firing on stale samples.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oraclePrice: new Gauge({
    name: "mento_pool_oracle_price",
    help: "Most recent non-zero MedianUpdated price, decimal-adjusted (raw / 1e24) from SortedOracles' FixidityLib scale. Feed direction (1 feedToken = X quoteToken). Used by the Oracle Jump alert summary.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oraclePrevPrice: new Gauge({
    name: "mento_pool_oracle_prev_price",
    help: "MedianUpdated price immediately before mento_pool_oracle_price, same scale and direction. Skipped until a second non-zero median has landed on the feed.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oraclePrevPriceAt: new Gauge({
    name: "mento_pool_oracle_prev_price_at",
    help: "Unix timestamp of the MedianUpdated event that produced oracle_prev_price. Paired with the gauge so the Oracle Jump alert can render `humanizeDuration` of (time() - this) as the previous-price age.",
    labelNames: poolLabels,
    registers: [register],
  }),
  healthStatus: new Gauge({
    name: "mento_pool_health_status",
    help: "Pool health status at last on-chain event (0=OK, 1=WARN, 2=CRITICAL, 3=N/A). Event-time snapshot, not live.",
    labelNames: poolLabels,
    registers: [register],
  }),
  bridgeLastPoll: new Gauge({
    name: "mento_pool_bridge_last_poll",
    help: "Unix timestamp of the last successful poll",
    registers: [register],
  }),
  rebalanceBlocked: new Gauge({
    name: "mento_pool_rebalance_blocked",
    help: "1 when a critical-breach pool's `rebalance(pool)` simulation reverts (i.e. the rebalancer can't close the breach right now). Labels carry the Solidity error code (`reason_code`) and a human-readable explanation (`reason_message`). Reset before each probe cycle, so transport failures and pools currently below the probe threshold simply leave the series absent.",
    labelNames: rebalanceBlockedLabels,
    registers: [register],
  }),
  rebalanceProbeLastRun: new Gauge({
    name: "mento_pool_rebalance_probe_last_run",
    help: "Unix timestamp of the last completed rebalance-reason probe cycle. 0 before the first cycle.",
    registers: [register],
  }),
};

export const counters = {
  pollErrors: new Counter({
    name: "mento_pool_bridge_poll_errors_total",
    help: "Total number of poll errors by bounded subsystem kind",
    labelNames: pollErrorLabels,
    registers: [register],
  }),
  deviationAlertTransitions: new Counter({
    name: "mento_pool_deviation_alert_transitions_total",
    help: "Total deviation alert state transitions observed by metrics-bridge, keyed by bounded from/to/reason labels.",
    labelNames: deviationAlertTransitionCounterLabels,
    registers: [register],
  }),
};

/**
 * Gauges that are NOT reset on each Hasura poll. Their lifecycles are owned
 * elsewhere:
 *   - `bridgeLastPoll` and `rebalanceProbeLastRun` are scalar self-monitoring
 *     gauges with no label set to evict.
 *   - `rebalanceBlocked` is reset by the rebalance probe cycle (not the
 *     poll cycle), so its labels survive between probes — wiping them on
 *     every 30s poll would leave the alert annotation flickering off most
 *     of the time, since probes only run every Nth poll.
 */
const POLL_PRESERVED_GAUGES = new Set<Gauge>([
  gauges.bridgeLastPoll,
  gauges.rebalanceProbeLastRun,
  gauges.rebalanceBlocked,
]);

export function updateMetrics(
  pools: PoolRow[],
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  resetPollGauges();

  const activePoolIds = new Set<string>();
  for (const pool of pools) {
    activePoolIds.add(pool.id);
    updatePoolMetrics(pool, nowSeconds);
  }
  pruneDeviationAlertStates(activePoolIds);
}

function resetPollGauges(): void {
  // Reset pool-level gauges to evict stale label sets from removed pools.
  for (const g of Object.values(gauges)) {
    if (!POLL_PRESERVED_GAUGES.has(g)) g.reset();
  }
}

function updatePoolMetrics(pool: PoolRow, nowSeconds: number): void {
  const derivedPair = poolName(pool.chainId, pool.token0, pool.token1);
  warnIfUnknown(pool, derivedPair);
  const labels = poolDisplayLabels(pool, derivedPair);

  recordDeviationAlertMetrics(pool, labels, nowSeconds);
  recordStatusAndOracleMetrics(pool, labels);
  recordDeviationMetrics(pool, labels);
  recordRebalanceMetrics(pool, labels);
  recordOraclePriceMetrics(pool, labels);
  recordLimitMetrics(pool, labels);
  recordReserveShareMetrics(pool, labels);
}

function recordDeviationAlertMetrics(
  pool: PoolRow,
  labels: PoolDisplayLabels,
  nowSeconds: number,
): void {
  const deviationAlert = observeDeviationAlertState(
    pool,
    labels.pair,
    nowSeconds,
  );
  gauges.deviationAlertState.set({ ...labels, state: deviationAlert.state }, 1);
  for (const transition of deviationAlert.newTransitions) {
    counters.deviationAlertTransitions.inc({
      ...labels,
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
    });
  }
  for (const transition of deviationAlert.activeTransitions) {
    gauges.deviationAlertTransitionActive.set(
      {
        ...labels,
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
        breach_started_at: transition.breachStartedAtLabel,
        breach_ended_at: transition.endedAtLabel,
        breach_duration: transition.durationLabel,
      },
      1,
    );
  }
}

function recordStatusAndOracleMetrics(
  pool: PoolRow,
  labels: PoolDisplayLabels,
): void {
  const oracleLabels = oracleUpdateMetricLabels(pool, labels);
  gauges.healthStatus.set(labels, healthStatusToNumber(pool.healthStatus));
  gauges.oracleOk.set(labels, pool.oracleOk ? 1 : 0);
  gauges.oracleTimestamp.set(oracleLabels, Number(pool.oracleTimestamp));
  gauges.oracleExpiry.set(oracleLabels, Number(pool.oracleExpiry));
}

function recordDeviationMetrics(
  pool: PoolRow,
  labels: PoolDisplayLabels,
): void {
  // Skip the "-1" no-data sentinel. The indexer writes "-1" both on initial
  // pool creation AND during no-data intervals (rebalanceThreshold <= 0),
  // even after hasHealthData has been set to true.
  const devRatio = fp(pool.lastDeviationRatio);
  if (devRatio >= 0) {
    gauges.deviationRatio.set(labels, devRatio);
  }
  gauges.deviationBreachStart.set(
    labels,
    Number(pool.deviationBreachStartedAt),
  );
  const openBreachPeak = fp(pool.currentOpenBreachPeak);
  const openBreachEntryThreshold =
    pool.currentOpenBreachEntryThreshold > 0
      ? pool.currentOpenBreachEntryThreshold
      : LEGACY_OPEN_BREACH_ENTRY_THRESHOLD;
  if (openBreachPeak > 0) {
    gauges.deviationOpenBreachPeakRatio.set(
      labels,
      openBreachPeak / openBreachEntryThreshold,
    );
  }
}

function recordRebalanceMetrics(
  pool: PoolRow,
  labels: PoolDisplayLabels,
): void {
  gauges.lastRebalancedAt.set(labels, Number(pool.lastRebalancedAt));
  // Skip only the explicit "-1" no-data sentinel the indexer writes before
  // a pool has ever rebalanced (or for degenerate rebalances with zero
  // pre-deviation). Negative non-sentinel values (rebalance moved price
  // FURTHER from oracle) are legitimate observations and MUST publish — the
  // `Rebalance Ineffective` alert explicitly treats `< 0` as worse-than-noop.
  if (pool.lastEffectivenessRatio !== "-1") {
    gauges.rebalanceEffectiveness.set(labels, fp(pool.lastEffectivenessRatio));
  }
  // Swap fee — skip the `-1` sentinel the indexer writes when the initial
  // RPC fetch at pool creation failed (rpc.ts:fetchFees). Without this gate
  // the `Oracle Jump` alert would see a "0 bps" threshold and fire on the
  // first real oracle movement. `-1` on either side means we can't trust
  // the sum.
  if (pool.lpFee >= 0 && pool.protocolFee >= 0) {
    gauges.swapFeeBps.set(labels, pool.lpFee + pool.protocolFee);
  }
}

function recordOraclePriceMetrics(
  pool: PoolRow,
  labels: PoolDisplayLabels,
): void {
  gauges.oracleJumpBps.set(labels, fp(pool.lastOracleJumpBps));
  gauges.oracleJumpAt.set(labels, Number(pool.lastOracleJumpAt));
  // Skip the 0 sentinel: the alert annotation gates on series presence so
  // a missing prev cleanly drops the line instead of rendering "0".
  if (pool.lastMedianPrice !== "0") {
    gauges.oraclePrice.set(
      labels,
      toHumanUnits(BigInt(pool.lastMedianPrice), SORTED_ORACLES_DECIMALS),
    );
  }
  // Pair-gate the prev fields. Post-migration the first MedianUpdated has
  // prevMedianPrice > 0 (carried from the old row) but prevMedianAt = 0
  // (new column default), so a price-only check would render a 1970
  // timestamp on the first jump after deploy.
  if (pool.prevMedianPrice !== "0" && pool.prevMedianAt !== "0") {
    gauges.oraclePrevPrice.set(
      labels,
      toHumanUnits(BigInt(pool.prevMedianPrice), SORTED_ORACLES_DECIMALS),
    );
    gauges.oraclePrevPriceAt.set(labels, Number(pool.prevMedianAt));
  }
}

function recordLimitMetrics(pool: PoolRow, labels: PoolDisplayLabels): void {
  gauges.limitPressure.set(
    { ...labels, token_index: "0" },
    fp(pool.limitPressure0),
  );
  gauges.limitPressure.set(
    { ...labels, token_index: "1" },
    fp(pool.limitPressure1),
  );
}

function recordReserveShareMetrics(
  pool: PoolRow,
  labels: PoolDisplayLabels,
): void {
  const r0 = Number(pool.reserves0) / 10 ** pool.token0Decimals;
  const r1 = Number(pool.reserves1) / 10 ** pool.token1Decimals;
  const total = r0 + r1;
  if (Number.isFinite(total) && total > 0) {
    const token0Symbol = tokenSymbol(pool.chainId, pool.token0) ?? "token0";
    const token1Symbol = tokenSymbol(pool.chainId, pool.token1) ?? "token1";
    gauges.reserveShareToken0.set(
      { ...labels, token_symbol: token0Symbol },
      r0 / total,
    );
    gauges.reserveShareToken1.set(
      { ...labels, token_symbol: token1Symbol },
      r1 / total,
    );
  }
}

/**
 * Build the shared pool-display label set used across all pool-scoped
 * gauges. Exposed so the rebalance probe can attach the same labels
 * (chain_name, pair, block_explorer_url, …) without re-deriving them.
 */
export type PoolDisplayLabels = {
  pool_id: string;
  chain_id: string;
  chain_name: string;
  pair: string;
  pool_address_short: string;
  block_explorer_url: string;
};

type OracleUpdateLabels = PoolDisplayLabels & {
  last_oracle_update_url: string;
};

function oracleUpdateMetricLabels(
  pool: PoolRow,
  labels: PoolDisplayLabels,
): OracleUpdateLabels {
  return {
    ...labels,
    last_oracle_update_url: pool.oracleTxHash
      ? (explorerTxUrl(pool.chainId, pool.oracleTxHash) ?? "")
      : "",
  };
}

export function poolDisplayLabels(
  pool: PoolRow,
  derivedPair = poolName(pool.chainId, pool.token0, pool.token1),
): PoolDisplayLabels {
  const address = poolIdAddress(pool.id);
  return {
    pool_id: pool.id,
    chain_id: String(pool.chainId),
    chain_name: chainSlug(pool.chainId),
    pair: derivedPair ?? pool.id,
    pool_address_short: shortAddress(address),
    block_explorer_url: explorerAddressUrl(pool.chainId, address) ?? "",
  };
}
