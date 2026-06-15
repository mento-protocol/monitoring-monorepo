// Canonical deviation thresholds shared by every TS package in this monorepo.
// Pure data — no runtime deps — so it's safe to import from indexer handlers,
// the metrics-bridge probe, and the dashboard alike.
//
// IMPORTANT: alerts/rules/main.tf and alerts/rules/rules-fpmms.tf hard-code
// these same numbers as HCL literals (1.01 for the OK/WARN boundary, 1.05 for
// the WARN/CRITICAL boundary). HCL can't import TS exports, so any change here
// must be mirrored there manually. `scripts/check-deviation-threshold-drift.mjs`
// enforces that mirror.

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
 * WARN/CRITICAL magnitude boundary. A pool past `DEVIATION_TOLERANCE_RATIO`
 * stays WARN until `priceDifference / rebalanceThreshold > DEVIATION_CRITICAL_RATIO`
 * AND the breach has outlived `DEVIATION_BREACH_GRACE_SECONDS`. Below this
 * magnitude, duration alone never escalates a breach to CRITICAL.
 *
 * Mirrors `DEVIATION_CRITICAL_NUM / DEVIATION_CRITICAL_DEN` in
 * `indexer-envio/src/pool/health.ts`; `test/deviationThresholdSharedConfigSync.test.ts`
 * enforces numeric parity and `test/healthStatusParity.test.ts` enforces
 * behavioral parity. Also gates the metrics-bridge rebalance-reason probe so
 * the annotation only attaches to alerts that can actually fire.
 */
export const DEVIATION_CRITICAL_RATIO = 1.05;
