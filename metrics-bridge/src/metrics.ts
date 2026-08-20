import { Gauge, Counter, Registry } from "prom-client";
import {
  chainSlug,
  explorerAddressUrl,
  explorerTxUrl,
  hasChain,
} from "@mento-protocol/config/chains";
import { poolName, tokenSymbol } from "@mento-protocol/config/tokens";
import { poolIdAddress, shortAddress } from "@mento-protocol/config/format";
import { toHumanUnits } from "@mento-protocol/config/units";
import { LEGACY_OPEN_BREACH_ENTRY_THRESHOLD } from "./config.js";
import {
  observeDeviationAlertState,
  pruneDeviationAlertStates,
} from "./deviation-alert-state.js";
import { classifyFxMarketPause } from "./fx-market.js";
import { isFpmmPool, isVirtualPool, type PoolRow } from "./types.js";

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
const ORACLE_STALE_SECONDS = 300;
const ORACLE_STALE_SECONDS_BY_CHAIN: Readonly<Record<number, number>> = {
  42220: 300,
  11142220: 300,
  143: 360,
  10143: 360,
};

// Pools whose token-count shares ARE their value shares, published into the
// value-share gauges when the oracle-frame conversion cannot run.
//
// Polygon EURm/EUROP is the only member. No oracle network publishes a
// EUROP/EUR price, so per ADR 0042 the pair runs on a hardcoded MANUAL rate
// feed pinned to 1:1 (`EUROPEUR` in `shared-config/oracle-reporters.json`).
// That feed has never landed a SortedOracles median, so `reserveValueShares`
// returns null and the pool would otherwise carry no depletion coverage at all
// under ADR 0067. At a rate of exactly 1 the oracle reference is 1, and the
// value share reduces to the count share — so here the count numbers are the
// depletion measure, not an approximation of it.
//
// Membership requires a rate pinned to 1 by construction. A pair that merely
// trades near parity does not qualify: its rate can move, and the count share
// would then quietly stop answering the depletion question.
//
// Keys are canonical pool IDs — `{chainId}-{lowercaseAddress}`, the form
// `indexer-envio/src/helpers.ts` builds and the only form Hasura returns.
const COUNT_SHARE_VALUE_FALLBACK_POOL_IDS: ReadonlySet<string> = new Set([
  "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
]);

/**
 * Whether the count shares may stand in for the value shares on this pool.
 *
 * Allowlist membership alone is not enough. The fallback exists for one state —
 * a pair with no oracle-network feed at all, whose rate is pinned to 1 — and
 * must not survive that pair acquiring a real feed. `lastMedianPrice` is what
 * distinguishes the two: it is zero only while a feed has never landed a
 * median, and a feed that once worked and then went dark deliberately RETAINS
 * its last non-zero value (see `reserveValueShares`).
 *
 * So a retained price means a real median existed for this pair, and the 1:1
 * assumption behind the allowlist no longer holds. Publishing a count share
 * there would replace a real valuation with a fabricated one at exactly the
 * moment the oracle went down, reading as healthy while the pool drains. That
 * case fails closed like every other pool.
 *
 * The condition is "no non-zero median was ever observed", NOT "the feed is
 * live right now". A zero median leaves a zero price in place
 * (`computeMedianLineageNext` in `indexer-envio/src/oracleJump.ts`), so a
 * report that expires or is removed before this pair ever priced keeps the
 * fallback on. That is deliberate: the 1:1 rate is a property of the pair —
 * EUROP has no oracle-network feed to disagree with — not of any one report's
 * freshness, so the value split stays correct while the report is stale. An
 * expired or removed report is a real problem, and the oracle-liveness plane
 * is what pages on it ("Oldest Report Expired [Polygon]" already carries
 * EUROPEUR remediation copy). ADR 0067 keeps depletion and oracle liveness as
 * independent ladders; suppressing a still-correct depletion share here would
 * drop a good signal without adding the outage signal, which already exists.
 */
function countSharesStandInForValue(
  pool: Pick<PoolRow, "id" | "lastMedianPrice">,
): boolean {
  if (!COUNT_SHARE_VALUE_FALLBACK_POOL_IDS.has(pool.id)) return false;
  return BigInt(pool.lastMedianPrice) === 0n;
}

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
const oracleMarketPauseLabels = [...poolLabels, "reason"] as const;
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
  | "hasura_rate_limit"
  | "update_metrics"
  | "mark_healthy"
  | "rebalance_probe"
  | "cdp_query"
  | "cdp_update";
const pollErrorLabels = ["kind"] as const;

export const gauges = {
  oracleOk: new Gauge({
    name: "mento_pool_oracle_ok",
    help: "Live scrape-time oracle usability (1=contract ok and last report is inside expiry, 0=not usable or expired).",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleContractOk: new Gauge({
    name: "mento_pool_oracle_contract_ok",
    help: "Raw event-time contract can-trade flag from the indexer (1=ok, 0=not ok), before scrape-time expiry derivation.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleMarketPause: new Gauge({
    name: "mento_pool_oracle_market_pause",
    help: "1 when an FX pool's oracle staleness is expected because TradFi markets are closed or inside the post-reopen grace window. Label reason is bounded.",
    labelNames: oracleMarketPauseLabels,
    registers: [register],
  }),
  oracleTimestamp: new Gauge({
    name: "mento_pool_oracle_timestamp",
    help: "Raw/display Unix timestamp from the indexer oracle cursor. Diagnostic only; live freshness uses mento_pool_oracle_live_timestamp.",
    labelNames: oracleUpdateLabels,
    registers: [register],
  }),
  oracleLiveTimestamp: new Gauge({
    name: "mento_pool_oracle_live_timestamp",
    help: "Unix timestamp of the freshness anchor used to derive live oracle usability.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleExpiry: new Gauge({
    name: "mento_pool_oracle_expiry",
    help: "Oracle report expiry window in seconds",
    labelNames: oracleUpdateLabels,
    registers: [register],
  }),
  vpOracleFresh: new Gauge({
    name: "mento_pool_vp_oracle_fresh",
    help: "VirtualPool oracle usability derived from trusted oracleTimestamp, median validity, and oracleFreshnessWindow (1=fresh and valid, 0=stale or invalid). Unknown window, untrusted cursor, or unknown median validity publishes no series.",
    labelNames: poolLabels,
    registers: [register],
  }),
  vpOracleMedianValid: new Gauge({
    name: "mento_pool_vp_oracle_median_valid",
    help: "VirtualPool median validity from indexed SortedOracles medianLive, active reporter count, and wrapped exchange minimumReports (1=valid, 0=invalid). Unknown VP freshness/config input publishes no series.",
    labelNames: poolLabels,
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
  // Value-weighted twins of the two gauges above. These are what the pool
  // depletion alerts read; the raw-count pair stays for the "100% USDT / 0%
  // USDm" diagnostic line and for pools whose orientation or median is
  // unknown. See `reserveValueShares` for the oracle-frame math and for why
  // a raw count share is not a depletion signal on an off-parity pair.
  reserveValueShareToken0: new Gauge({
    name: "mento_pool_reserve_value_share_token0",
    help: "Value-weighted share of pool reserves held in token0: r0_normalized × oracleRef / (r0_normalized × oracleRef + r1_normalized) ∈ [0, 1], where oracleRef is the price of token0 denominated in token1 (`mento_pool_oracle_price`, inverted when the pool's `invertRateFeed` says token0 is the feed's quote token). Equals the token-count share only when oracleRef is exactly 1; near-parity is not enough. Skipped when reserves are zero, the median price is absent or no longer live (a zero-median outage retains the last price), or the feed orientation has not been read on chain — no series rather than a wrong one. The one exception is a pool whose rate feed is hardcoded 1:1 and has never landed a non-zero median (Polygon EURm/EUROP), where the token-count share is the value share and is published here instead; a feed that ever priced the pair is outside that exception, including after its median goes dark. Carries the same `token_symbol` label as `mento_pool_reserve_share_token0`.",
    labelNames: reserveShareLabels,
    registers: [register],
  }),
  reserveValueShareToken1: new Gauge({
    name: "mento_pool_reserve_value_share_token1",
    help: "Value-weighted share of pool reserves held in token1 (mirror of mento_pool_reserve_value_share_token0): r1_normalized / (r0_normalized × oracleRef + r1_normalized). Same skip conditions, the same hardcoded-1:1 exception, and the same `token_symbol` label as its token0 twin.",
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
    help: "1 only when every active liquidity strategy on a critical-breach pool returns a confirmed blocked result. Any actionable strategy, transport failure, or unclassified strategy leaves the pool-level series absent. Labels carry one deterministic bounded Solidity reason (`reason_code`, `reason_message`).",
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
    if (isVirtualPool(pool)) {
      recordVpOracleMetrics(pool, nowSeconds);
      continue;
    }
    if (isFpmmPool(pool)) {
      activePoolIds.add(pool.id);
      updatePoolMetrics(pool, nowSeconds);
    }
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
  recordStatusAndOracleMetrics(pool, labels, nowSeconds);
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
  nowSeconds: number,
): void {
  const oracleLabels = oracleUpdateMetricLabels(pool, labels);
  gauges.healthStatus.set(labels, healthStatusToNumber(pool.healthStatus));
  gauges.oracleContractOk.set(labels, pool.oracleOk ? 1 : 0);
  // Alert liveness uses the exact SortedOracles median timestamp. The raw
  // `oracleTimestamp` gauge remains diagnostic (report/state-sync touch time)
  // and must not renew the contract freshness boundary.
  gauges.oracleOk.set(labels, isOracleLive(pool, nowSeconds) ? 1 : 0);
  const marketPause = classifyFxMarketPause(labels.pair, nowSeconds);
  if (marketPause !== null) {
    gauges.oracleMarketPause.set({ ...labels, reason: marketPause }, 1);
  }
  gauges.oracleTimestamp.set(oracleLabels, Number(pool.oracleTimestamp));
  gauges.oracleLiveTimestamp.set(labels, Number(pool.lastOracleReportAt));
  gauges.oracleExpiry.set(oracleLabels, oracleExpirySeconds(pool));
}

function recordVpOracleMetrics(pool: PoolRow, nowSeconds: number): void {
  if (pool.wrappedExchangeDeprecated) return;
  const derivedPair = poolName(pool.chainId, pool.token0, pool.token1);
  const labels = poolDisplayLabels(pool, derivedPair);
  const medianValid = vpOracleMedianValidity(pool);
  if (medianValid !== null) {
    gauges.vpOracleMedianValid.set(labels, medianValid);
  }
  const freshness = vpOracleFreshness(pool, nowSeconds);
  if (freshness === null) return;
  warnIfUnknown(pool, derivedPair);
  gauges.vpOracleFresh.set(labels, freshness);
}

export function vpOracleMedianValidity(
  pool: Pick<
    PoolRow,
    | "medianLive"
    | "oracleNumReporters"
    | "oracleFreshnessWindow"
    | "tokenDecimalsKnown"
    | "wrappedExchangeMinimumReports"
  >,
): number | null {
  const inputs = trustedVpOracleMedianInputs(pool);
  if (inputs === null) return null;
  if (pool.medianLive === false) return 0;
  if (inputs.oracleNumReporters < inputs.minimumReports) return 0;
  return pool.medianLive === true ? 1 : null;
}

function trustedVpOracleMedianInputs(
  pool: Pick<
    PoolRow,
    | "oracleNumReporters"
    | "oracleFreshnessWindow"
    | "tokenDecimalsKnown"
    | "wrappedExchangeMinimumReports"
  >,
): { minimumReports: number; oracleNumReporters: number } | null {
  if (pool.tokenDecimalsKnown !== true) return null;
  const freshnessWindow = Number(pool.oracleFreshnessWindow);
  if (!Number.isFinite(freshnessWindow) || freshnessWindow <= 0) return null;
  const minimumReports = Number(pool.wrappedExchangeMinimumReports);
  const oracleNumReporters = Number(pool.oracleNumReporters);
  if (
    !Number.isFinite(minimumReports) ||
    minimumReports <= 0 ||
    !Number.isFinite(oracleNumReporters) ||
    oracleNumReporters < 0
  ) {
    return null;
  }
  return { minimumReports, oracleNumReporters };
}

export function vpOracleFreshness(
  pool: Pick<
    PoolRow,
    | "oracleFreshnessWindow"
    | "oracleTimestamp"
    | "medianLive"
    | "oracleNumReporters"
    | "tokenDecimalsKnown"
    | "wrappedExchangeMinimumReports"
  >,
  nowSeconds: number,
): number | null {
  const medianValid = vpOracleMedianValidity(pool);
  if (medianValid === null) return null;
  if (medianValid === 0) return 0;
  if (pool.tokenDecimalsKnown !== true) return null;
  const freshnessWindow = Number(pool.oracleFreshnessWindow);
  const liveReportAt = Number(pool.oracleTimestamp);
  if (
    !Number.isFinite(freshnessWindow) ||
    freshnessWindow <= 0 ||
    !Number.isFinite(liveReportAt) ||
    liveReportAt <= 0
  ) {
    return null;
  }
  return nowSeconds - liveReportAt <= freshnessWindow ? 1 : 0;
}

export function isOracleLive(
  pool: Pick<
    PoolRow,
    "chainId" | "oracleOk" | "lastOracleReportAt" | "oracleExpiry"
  >,
  nowSeconds: number,
): boolean {
  const timestamp = Number(pool.lastOracleReportAt);
  const expiry = oracleExpirySeconds(pool);
  return (
    pool.oracleOk &&
    Number.isFinite(timestamp) &&
    timestamp > 0 &&
    nowSeconds - timestamp <= expiry
  );
}

function oracleExpirySeconds(
  pool: Pick<PoolRow, "chainId" | "oracleExpiry">,
): number {
  const indexed = Number(pool.oracleExpiry);
  if (Number.isFinite(indexed) && indexed > 0) return indexed;
  return ORACLE_STALE_SECONDS_BY_CHAIN[pool.chainId] ?? ORACLE_STALE_SECONDS;
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

/**
 * Value-weighted reserve shares, or `null` when they cannot be computed.
 *
 * A token-count share answers "how many tokens sit on each side", which is
 * only a depletion signal when the two legs are worth roughly the same. On an
 * off-parity pair it is dominated by the exchange rate: a healthy, balanced
 * JPYm/USDm pool reads 0.4% / 99.6% by count purely because one JPY is worth
 * ~0.0063 USD. What an operator needs to know — can a swapper still get out
 * on this side — is a question about value.
 *
 * The conversion uses the same frame the FPMM contract and the indexer's
 * `priceDifference` use (`indexer-envio/src/priceDifference.ts`):
 * `reservePrice = r1_normalized / r0_normalized` is compared against
 * `oracleRef`, the price of token0 denominated in token1. `oracleRef` is the
 * SortedOracles median in feed direction, inverted when the pool's on-chain
 * `invertRateFeed` flag says token0 is the feed's quote token. Weighting the
 * legs by `(oracleRef, 1)` therefore reproduces the on-chain equilibrium:
 * a pool sitting exactly on its oracle is 50/50 here, and the min side share
 * is exactly the "how lopsided by value" number the depletion floors want.
 *
 * `invertRateFeed` is per-pool, not per-pair — token ordering differs between
 * chains, and the flag is what compensates. Both JPYm/USDm pools carry the
 * same feed with opposite flags because Celo lists USDm as token0 and Monad
 * lists JPYm as token0. Assuming one orientation for all pools produces a
 * confident wrong answer on the other half of them, so an unread flag
 * (`invertRateFeedKnown === false`) publishes nothing at all.
 *
 * `medianLive` gates for the same fail-closed reason. It is false when the
 * feed's most recent `MedianUpdated` carried a zero median, and
 * `lastMedianPrice` deliberately RETAINS the last non-zero value across that
 * outage — so a price check alone would keep publishing a share derived from a
 * rate the contract itself no longer honours. `hasFreshLiveMedian` in
 * `indexer-envio/src/priceDifference.ts` refuses to derive rebalance state
 * under the same condition; this follows it rather than inventing a second
 * answer to "is this feed usable".
 *
 * Price precision follows `mento_pool_oracle_price`: both go through
 * `toHumanUnits`, so an operator can reproduce the share from the two
 * published gauges by hand.
 *
 * A null here normally means the value-share gauges publish nothing for the
 * pool. `recordReserveShareMetrics` carries one narrow exception for a pool
 * pinned to a 1:1 rate that has never landed a non-zero median — see
 * `countSharesStandInForValue`. A median that went dark after pricing the pair
 * retains its last non-zero value, so it never takes that path.
 */
export function reserveValueShares(
  pool: Pick<
    PoolRow,
    | "reserves0"
    | "reserves1"
    | "token0Decimals"
    | "token1Decimals"
    | "lastMedianPrice"
    | "medianLive"
    | "invertRateFeed"
    | "invertRateFeedKnown"
  >,
): { share0: number; share1: number } | null {
  if (pool.invertRateFeedKnown !== true || pool.medianLive !== true) {
    return null;
  }
  const price = toHumanUnits(
    BigInt(pool.lastMedianPrice),
    SORTED_ORACLES_DECIMALS,
  );
  if (!Number.isFinite(price) || price <= 0) return null;
  const r0 = Number(pool.reserves0) / 10 ** pool.token0Decimals;
  const r1 = Number(pool.reserves1) / 10 ** pool.token1Decimals;
  // `Math.min` rather than a check per leg: NaN propagates through it, and an
  // infinity that slips past is caught by the finite check on the total below.
  if (!(Math.min(r0, r1) >= 0)) return null;
  const oracleRef = pool.invertRateFeed ? 1 / price : price;
  const value0 = r0 * oracleRef;
  const total = value0 + r1;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { share0: value0 / total, share1: r1 / total };
}

function recordReserveShareMetrics(
  pool: PoolRow,
  labels: PoolDisplayLabels,
): void {
  const r0 = Number(pool.reserves0) / 10 ** pool.token0Decimals;
  const r1 = Number(pool.reserves1) / 10 ** pool.token1Decimals;
  const total = r0 + r1;
  if (!Number.isFinite(total) || total <= 0) return;
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
  // Value shares need a usable oracle on top of the reserves, so they publish
  // on a subset of the pools the count shares cover. Absent series (no median
  // yet, a median that has gone dark, unread orientation) leave the depletion
  // rules at NoData, which they treat as OK — the dark feed itself is what the
  // oracle staleness rules page on.
  //
  // A real value share always wins. The count-share fallback runs only on the
  // null path, and only for a pool that has never had a non-zero median — see
  // `countSharesStandInForValue`, which is what keeps this from overwriting a
  // real valuation when that pool's oracle goes dark.
  const valueShares =
    reserveValueShares(pool) ??
    (countSharesStandInForValue(pool)
      ? { share0: r0 / total, share1: r1 / total }
      : null);
  if (!valueShares) return;
  gauges.reserveValueShareToken0.set(
    { ...labels, token_symbol: token0Symbol },
    valueShares.share0,
  );
  gauges.reserveValueShareToken1.set(
    { ...labels, token_symbol: token1Symbol },
    valueShares.share1,
  );
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
