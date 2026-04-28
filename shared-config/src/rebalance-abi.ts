/**
 * Single source of truth for the FPMM liquidity-strategy ABI subset and
 * Solidity-error → human-readable message map used by the rebalance probe.
 *
 * Two consumers today:
 *   - `ui-dashboard/src/lib/rebalance-check.ts` (pool-detail tooltip + KPI strip)
 *   - `metrics-bridge/src/rebalance-check.ts` (Slack alert annotation)
 *
 * Drift between the two would mean the dashboard explains a revert that the
 * Slack alert reports as `unknown` (or vice versa). Keeping the data here
 * forces both probes to see exactly the same vocabulary.
 *
 * Implementation notes:
 *   - `STRATEGY_ABI_SOURCES` is a plain string[] of human-readable ABI fragments.
 *     Consumers feed it into viem's `parseAbi(...)` to materialise the typed
 *     ABI — that keeps the viem dependency out of `shared-config/`. The
 *     `as const` annotation preserves literal types so `parseAbi` can produce
 *     a strongly-typed ABI on the consumer side.
 *   - `ERROR_MESSAGES` is a flat lookup map. The `decodeBlockedRevert` glue
 *     stays in each consumer because it carries probe-specific concerns
 *     (the dashboard adds enrichment fetches for `CDPLS_*_BALANCE_TOO_LOW` /
 *     `RLS_RESERVE_OUT_OF_COLLATERAL`; the bridge collapses healthy no-ops
 *     to `ok` and routes the unbounded payload to the diagnostic log channel
 *     for cardinality + Slack-injection-safety reasons).
 */

/**
 * Strategy ABI as a const-string array — feed this into viem's `parseAbi(...)`
 * on the consumer side. The list covers every error code emitted by the
 * FPMM rebalance pipeline plus the detection-only getters
 * (`getCDPConfig`/`reserve`/`getPools`) needed to identify the strategy
 * type before simulating.
 *
 * Drift across the two consumers (dashboard tooltip + Slack alert annotation)
 * would mean a revert decoded by one probe falls through to `unknown` on
 * the other. Add new errors / detection getters here, never inline.
 */
export const STRATEGY_ABI_SOURCES = [
  // Shared
  "function rebalance(address pool) external",
  // OLS-specific probe: view-only, handles the zero-sender path explicitly.
  // CDP/Reserve `rebalance` simulates fine from address(0) (tokens move
  // strategy → pool), but OLS routes ERC20 transfers from `msg.sender`,
  // so the address(0) probe always reverts inside ERC20 — meaningless.
  "function determineAction(address pool) external view returns ((address pool, uint256 reserveNumerator, uint256 reserveDenominator, uint256 oraclePriceNumerator, uint256 oraclePriceDenominator, bool reservePriceAboveOraclePrice, uint16 rebalanceThreshold, address token0, address token1, uint8 decimals0, uint8 decimals1, bool isToken0Debt, uint64 liquiditySourceIncentiveExpansion, uint64 protocolIncentiveExpansion, uint64 liquiditySourceIncentiveContraction, uint64 protocolIncentiveContraction) ctx, (uint8 direction, uint256 amount0Out, uint256 amount1Out, uint256 amountOwedToPool) action)",
  // Used by the dashboard's reserve-enrichment path (find the debt token).
  // Bridge ignores it — dropping enrichment keeps the alert annotation
  // bounded — but keeping it in the canonical ABI is harmless.
  "function poolConfigs(address pool) external view returns (bool isToken0Debt, uint32 lastRebalance, uint32 rebalanceCooldown, address protocolFeeRecipient, uint64 liquiditySourceIncentiveExpansion, uint64 protocolIncentiveExpansion, uint64 liquiditySourceIncentiveContraction, uint64 protocolIncentiveContraction)",
  // Strategy-type detection probes (zero-arg getters, cheap).
  "function getCDPConfig(address pool) external view returns ((address stabilityPool, address collateralRegistry, uint256 stabilityPoolPercentage, uint256 maxIterations))",
  "function reserve() external view returns (address)",
  "function getPools() external view returns (address[])",
  // Shared LS_*
  "error LS_BAD_INCENTIVE()",
  "error LS_CAN_ONLY_REBALANCE_ONCE(address pool)",
  "error LS_COOLDOWN_ACTIVE()",
  "error LS_DEBT_TOKEN_NOT_IN_POOL()",
  "error LS_HOOK_NOT_CALLED()",
  "error LS_INCENTIVE_TOO_HIGH()",
  "error LS_INVALID_DECIMAL()",
  "error LS_INVALID_OWNER()",
  "error LS_INVALID_PRICES()",
  "error LS_INVALID_SENDER()",
  "error LS_INVALID_THRESHOLD()",
  "error LS_POOL_ALREADY_EXISTS()",
  "error LS_POOL_MUST_BE_SET()",
  "error LS_POOL_NOT_FOUND()",
  "error LS_POOL_NOT_REBALANCEABLE()",
  "error LS_PROTOCOL_FEE_RECIPIENT_REQUIRED()",
  "error LS_STRATEGY_EXECUTION_FAILED()",
  "error LS_ZERO_DECIMAL()",
  // CDP strategy
  "error CDPLS_COLLATERAL_REGISTRY_IS_ZERO()",
  "error CDPLS_INVALID_STABILITY_POOL_PERCENTAGE()",
  "error CDPLS_OUT_OF_FUNDS_FOR_REDEMPTION_SUBSIDY()",
  "error CDPLS_REDEMPTION_FEE_TOO_LARGE()",
  "error CDPLS_REDEMPTION_SHORTFALL_TOO_LARGE(uint256 shortfall)",
  "error CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()",
  "error CDPLS_STABILITY_POOL_IS_ZERO()",
  // Reserve strategy
  "error RLS_COLLATERAL_TO_POOL_FAILED()",
  "error RLS_INVALID_RESERVE()",
  "error RLS_RESERVE_OUT_OF_COLLATERAL()",
  "error RLS_TOKEN_IN_NOT_SUPPORTED()",
  "error RLS_TOKEN_OUT_NOT_SUPPORTED()",
  // OLS strategy
  "error OLS_OUT_OF_COLLATERAL()",
  "error OLS_OUT_OF_DEBT()",
  // FPMM pool-side errors (can bubble through strategy.rebalance → pool.rebalance)
  "error NotLiquidityStrategy()",
  "error PriceDifferenceTooSmall()",
  "error PriceDifferenceNotImproved()",
  "error PriceDifferenceMovedInWrongDirection()",
  "error PriceDifferenceMovedTooFarFromThresholds()",
  "error RebalanceDirectionInvalid()",
  "error RebalanceThresholdTooHigh()",
  "error RebalanceIncentiveTooHigh()",
  "error ReferenceRateNotSet()",
  "error ReserveValueDecreased()",
  "error ReservesEmpty()",
] as const;

/**
 * Solidity error name → human-readable explanation. Slack alert annotations
 * and dashboard tooltips share the same vocabulary so operators see the
 * same wording across surfaces.
 *
 * Bounded enum (~30 codes). Both consumers' `decodeBlockedRevert` glue
 * MUST keep `reason_message` inside this map (built-in `Error(string)` /
 * `Panic(uint256)` reverts collapse to fixed strings — see
 * `metrics-bridge/src/rebalance-check.ts`) so the Prometheus label
 * cardinality stays bounded and a non-canonical strategy can't inject
 * Slack mrkdwn through the alert body.
 */
export const ERROR_MESSAGES: Record<string, string> = {
  // CDP strategy
  CDPLS_STABILITY_POOL_BALANCE_TOO_LOW:
    "Stability pool has insufficient liquidity to fully rebalance",
  CDPLS_STABILITY_POOL_IS_ZERO:
    "No stability pool configured for this strategy",
  CDPLS_COLLATERAL_REGISTRY_IS_ZERO: "Collateral registry not configured",
  CDPLS_OUT_OF_FUNDS_FOR_REDEMPTION_SUBSIDY:
    "Insufficient funds to cover redemption subsidy",
  CDPLS_REDEMPTION_FEE_TOO_LARGE: "Redemption fee exceeds tolerance",
  CDPLS_REDEMPTION_SHORTFALL_TOO_LARGE:
    "Redemption shortfall exceeds tolerance",
  CDPLS_INVALID_STABILITY_POOL_PERCENTAGE:
    "Invalid stability pool percentage configuration",
  // Reserve strategy
  RLS_RESERVE_OUT_OF_COLLATERAL:
    "Reserve has insufficient collateral to rebalance",
  RLS_INVALID_RESERVE: "Reserve contract not configured",
  RLS_COLLATERAL_TO_POOL_FAILED: "Collateral transfer to pool failed",
  RLS_TOKEN_IN_NOT_SUPPORTED: "Collateral token not supported by reserve",
  RLS_TOKEN_OUT_NOT_SUPPORTED: "Debt token not supported by reserve",
  // Open liquidity strategy
  OLS_OUT_OF_COLLATERAL:
    "Strategy has no collateral liquidity available to rebalance",
  OLS_OUT_OF_DEBT: "Strategy has no debt liquidity available to rebalance",
  // Shared
  LS_COOLDOWN_ACTIVE: "Rebalance cooldown is active — retry shortly",
  LS_POOL_NOT_REBALANCEABLE: "Pool deviation is below the rebalance threshold",
  LS_INVALID_PRICES: "Oracle price data is invalid or stale",
  LS_CAN_ONLY_REBALANCE_ONCE: "Pool was already rebalanced this block",
  LS_POOL_NOT_FOUND: "Pool is not registered with this strategy",
  LS_STRATEGY_EXECUTION_FAILED: "Strategy execution failed internally",
  LS_HOOK_NOT_CALLED:
    "Pool hook was not invoked — possible contract misconfiguration",
  LS_BAD_INCENTIVE: "Incentive configuration is invalid",
  LS_INCENTIVE_TOO_HIGH: "Rebalance incentive exceeds allowed maximum",
  LS_DEBT_TOKEN_NOT_IN_POOL: "Debt token not found in pool pair",
  LS_INVALID_DECIMAL: "Token decimal configuration is invalid",
  LS_INVALID_OWNER: "Unauthorized — only owner can call this",
  LS_INVALID_SENDER: "Unauthorized caller",
  LS_INVALID_THRESHOLD: "Rebalance threshold is out of valid range",
  LS_POOL_ALREADY_EXISTS: "Pool is already registered",
  LS_POOL_MUST_BE_SET: "Pool address cannot be zero",
  LS_PROTOCOL_FEE_RECIPIENT_REQUIRED: "Protocol fee recipient must be set",
  LS_ZERO_DECIMAL: "Token has zero decimals",
  // FPMM pool-side errors
  NotLiquidityStrategy: "Caller is not a registered liquidity strategy",
  PriceDifferenceTooSmall: "Pool deviation is below the rebalance threshold",
  PriceDifferenceNotImproved: "Rebalance did not improve the price deviation",
  PriceDifferenceMovedInWrongDirection:
    "Rebalance moved the price in the wrong direction",
  PriceDifferenceMovedTooFarFromThresholds:
    "Rebalance moved the price too far past the threshold",
  RebalanceDirectionInvalid: "Invalid rebalance direction",
  RebalanceThresholdTooHigh: "Rebalance threshold exceeds allowed maximum",
  RebalanceIncentiveTooHigh: "Rebalance incentive exceeds allowed maximum",
  ReferenceRateNotSet: "Oracle reference rate is not configured",
  ReserveValueDecreased: "Pool reserve value decreased after rebalance",
  ReservesEmpty: "Pool reserves are empty",
};

/**
 * Revert codes where the strategy refuses to rebalance BECAUSE the pool is
 * healthy — not because anything is wrong. Both consumers collapse these
 * to a passive "no action needed" state so no red "blocked" line appears
 * in the UI / alert annotation when the rebalancer is just waiting for
 * the pool to drift further past threshold.
 */
export const HEALTHY_NO_OP_ERRORS: ReadonlySet<string> = new Set([
  "LS_POOL_NOT_REBALANCEABLE",
  "PriceDifferenceTooSmall",
]);
