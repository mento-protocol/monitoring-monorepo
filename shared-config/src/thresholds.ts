// Canonical pool-health thresholds shared by every TS package in this
// monorepo. Pure data — no runtime deps — so it's safe to import from indexer
// handlers, the metrics-bridge probe, and the dashboard alike.
//
// Two independent ladders live here, and they answer different questions:
//
//   - Deviation ratio (`DEVIATION_TOLERANCE_RATIO`, `DEVIATION_CRITICAL_RATIO`)
//     classifies how far a pool has drifted from its rebalance boundary. It
//     drives dashboard health badges, breach-history bucketing, the indexer's
//     persisted breach accounting, and metrics-bridge probe eligibility.
//   - Depletion side share (`POOL_DEPLETION_*_SHARE`) measures user impact:
//     how thin the smaller side of the pool has become.
//
// Since ADR 0067 only the second ladder pages. Deviation magnitude is an
// analytics classification, not an alert severity.
//
// IMPORTANT: alerts/rules/rules-fpmms.tf and alerts/rules/main.tf hard-code
// some of these numbers as HCL literals — `1.01` for the OK/WARN boundary and
// both depletion shares. HCL can't import TS exports, so any change to a
// mirrored constant must be mirrored there manually;
// `scripts/alerts/check-deviation-threshold-drift.mjs` enforces that mirror and
// names every site it checks. `DEVIATION_CRITICAL_RATIO` is deliberately NOT
// mirrored into Terraform any more.

/**
 * OK/WARN boundary. A pool is considered "within tolerance" while
 * `priceDifference / rebalanceThreshold ≤ DEVIATION_TOLERANCE_RATIO`.
 * Strict `>` flips the pool to WARN (or above).
 *
 * Mirrors `DEVIATION_TOLERANCE_NUM / DEVIATION_TOLERANCE_DEN` in
 * `indexer-envio/src/pool/health.ts`; `test/deviationThresholdSharedConfigSync.test.ts`
 * enforces numeric parity and `test/healthStatusParity.test.ts` enforces
 * behavioral parity with the dashboard's `computeHealthStatus`.
 */
export const DEVIATION_TOLERANCE_RATIO = 1.01;

/**
 * WARN/CRITICAL magnitude boundary for the ANALYTICS classification. A pool
 * past `DEVIATION_TOLERANCE_RATIO` stays WARN until
 * `priceDifference / rebalanceThreshold > DEVIATION_CRITICAL_RATIO` AND the
 * breach has outlived `DEVIATION_BREACH_GRACE_SECONDS`. Below this magnitude,
 * duration alone never escalates a breach to CRITICAL.
 *
 * This is a classification, not an alert severity. It drives:
 *   - the dashboard's pool health badge and its breach-history bucketing,
 *   - the indexer's persisted `criticalDurationSeconds` accounting
 *     (`indexer-envio/src/pool/health.ts`),
 *   - `classifyDeviationAlertState` and the `mento_pool_deviation_alert_state`
 *     gauge in metrics-bridge,
 *   - eligibility for the metrics-bridge rebalance-reason probe, where it acts
 *     as a cost gate that keeps RPC simulation proportional to the handful of
 *     pools deep enough in breach to be worth explaining.
 *
 * Since ADR 0067 no Grafana rule fires on it: an oracle-priced pool quoting
 * 5% past its rebalance boundary costs a swapper nothing, so magnitude alone
 * stopped being pageable. `Rebalancer Stale` covers the actionable mid-range
 * failure and `Pool Depletion Risk` covers user impact.
 *
 * Mirrors `DEVIATION_CRITICAL_NUM / DEVIATION_CRITICAL_DEN` in
 * `indexer-envio/src/pool/health.ts`; `test/deviationThresholdSharedConfigSync.test.ts`
 * enforces numeric parity and `test/healthStatusParity.test.ts` enforces
 * behavioral parity.
 */
export const DEVIATION_CRITICAL_RATIO = 1.05;

/**
 * Pool depletion CRITICAL floor, as a share of normalized reserves held by the
 * smaller side. Below it the thin leg no longer has the depth to absorb normal
 * swap size: an FPMM's quoted bandwidth in one direction is bounded by what
 * that side actually holds, so a 15/85 pool starts rejecting trades a 50/50
 * pool of the same TVL would serve.
 *
 * Mirrored into the `Pool Depletion Risk` Grafana evaluator in
 * `alerts/rules/rules-fpmms.tf`, and enforced by
 * `scripts/alerts/check-deviation-threshold-drift.mjs`.
 */
export const POOL_DEPLETION_CRITICAL_SHARE = 0.2;

/**
 * Pool depletion PAGE floor, same units as `POOL_DEPLETION_CRITICAL_SHARE`.
 * Below it the pool is effectively one-sided: bandwidth exhaustion is imminent
 * (a 95/5 pool has almost nothing left to sell of the thin token) and once that
 * side reaches zero, every swap into it reverts outright. That is direct,
 * observable user impact, so it pages rather than posting to Slack alone.
 *
 * The two shares partition the range with no gap and no overlap — the critical
 * rule's PromQL floors at this value, the page rule's evaluator caps at it — so
 * one depleting pool produces exactly one notification.
 *
 * Mirrored into the `Pool Nearly One-Sided` Grafana evaluator and the
 * `pool_depletion_critical_active_promql` floor in `alerts/rules/main.tf`, both
 * enforced by `scripts/alerts/check-deviation-threshold-drift.mjs`.
 */
export const POOL_DEPLETION_PAGE_SHARE = 0.1;
