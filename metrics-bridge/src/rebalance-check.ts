/**
 * Rebalance feasibility probe — vendored, slimmed-down port of
 * `ui-dashboard/src/lib/rebalance-check.ts`.
 *
 * The dashboard runs a richer probe with strategy-type detection and
 * collateral/balance enrichment for the pool-detail page tooltip. The
 * Slack alert annotation only needs the error code + human-readable
 * message, so this module drops:
 *
 * - Enrichment (stability pool balance, reserve collateral) — operators
 *   click through to the dashboard for that.
 *
 * Strategy-type detection IS retained — OLS pools route `rebalance` through
 * ERC20 transfers from `msg.sender`, so simulating from `address(0)`
 * reverts inside ERC20 with a meaningless error every time. The dashboard
 * branches on the detected type and uses `determineAction(pool)` (a view-
 * only function that handles the zero-sender path explicitly) for OLS.
 *
 * If a third consumer ever needs the probe, extract this + the dashboard's
 * `rebalance-check.ts` into a `shared-config/rebalance-check` module
 * instead of vendoring a third copy.
 */

import {
  decodeErrorResult,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  parseAbi,
} from "viem";

/**
 * Solidity custom errors emitted by the FPMM rebalance pipeline + the
 * detection-only getters needed to identify the strategy type. Mirror of
 * the dashboard ABI in `ui-dashboard/src/lib/rebalance-check.ts:21-81`
 * minus the enrichment getters (`poolConfigs`) which the alert annotation
 * doesn't need.
 *
 * Keep the error list in sync with the dashboard ABI — drift would mean the
 * alert annotation reports `unknown` for codes the dashboard handles.
 */
const STRATEGY_ABI = parseAbi([
  "function rebalance(address pool) external",
  // OLS-specific probe: view-only, handles the zero-sender path explicitly,
  // so it's the right substitute for `rebalance` simulation on OLS pools.
  "function determineAction(address pool) external view returns ((address pool, uint256 reserveNumerator, uint256 reserveDenominator, uint256 oraclePriceNumerator, uint256 oraclePriceDenominator, bool reservePriceAboveOraclePrice, uint16 rebalanceThreshold, address token0, address token1, uint8 decimals0, uint8 decimals1, bool isToken0Debt, uint64 liquiditySourceIncentiveExpansion, uint64 protocolIncentiveExpansion, uint64 liquiditySourceIncentiveContraction, uint64 protocolIncentiveContraction) ctx, (uint8 direction, uint256 amount0Out, uint256 amount1Out, uint256 amountOwedToPool) action)",
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
  // FPMM pool-side errors
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
]);

/**
 * Error code → human-readable explanation. Vendored from the dashboard's
 * `ERROR_MESSAGES` map (`ui-dashboard/src/lib/rebalance-check.ts:93-152`).
 * Keep wording aligned — Slack operators and dashboard tooltips share the
 * same vocabulary.
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
 * Codes that mean "the pool is healthy enough that the strategy refused to
 * rebalance" — surfacing these as a "blocked" annotation would be misleading.
 * The probe-cycle gating in `poller.ts` should already exclude pools below
 * threshold, but if one slips through (eval-race) we treat it as not-blocked
 * rather than emit a false "blocked" annotation.
 */
const HEALTHY_NO_OP_ERRORS: ReadonlySet<string> = new Set([
  "LS_POOL_NOT_REBALANCEABLE",
  "PriceDifferenceTooSmall",
]);

export type StrategyType = "cdp" | "reserve" | "ols" | "unknown";

export type RebalanceProbeResult =
  | { kind: "ok" } // Probe succeeded — pool is rebalanceable.
  | { kind: "blocked"; reasonCode: string; reasonMessage: string }
  | { kind: "transport_error"; error: string } // RPC down / 401 / timeout.
  | { kind: "skip"; reason: string }; // Detection failed — no metric, no log spam.

/**
 * Detect the liquidity strategy type by probing strategy-specific getters.
 * Mirror of `detectStrategyType` in
 * `ui-dashboard/src/lib/rebalance-check.ts:300`.
 *
 *   1. `getCDPConfig(pool)` → CDP
 *   2. `reserve()` → Reserve
 *   3. `getPools()` → OLS
 *   4. otherwise → unknown (caller skips, no metric emitted)
 *
 * Only swallows contract-shape reverts ("function not found" on wrong ABI).
 * Transport errors propagate so the caller can log + skip without
 * mistaking an RPC outage for an unidentified strategy.
 */
export async function detectStrategyType(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<StrategyType> {
  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getCDPConfig",
      args: [pool],
    });
    return "cdp";
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "reserve",
    });
    return "reserve";
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getPools",
    });
    return "ols";
  } catch (err) {
    if (!isContractRevert(err)) throw err;
  }

  return "unknown";
}

/**
 * Simulate the appropriate probe function against the strategy contract and
 * decode the revert. Returns:
 *   - `ok`         — the probe succeeded (no revert). Caller emits no metric.
 *   - `blocked`    — the probe reverted with a known/decodable error.
 *   - `transport_error` — RPC / network failure. Caller emits no metric and
 *                         logs the failure for operator awareness.
 *   - `skip`       — strategy type couldn't be identified (EOA, wrong proxy,
 *                    new strategy class). Caller emits no metric.
 *
 * Probe selection by strategy type:
 *   - CDP / Reserve: simulate `rebalance(pool)` from `address(0)` — these
 *     strategies source tokens from the strategy contract itself, so the
 *     zero-sender simulation is valid.
 *   - OLS: simulate `determineAction(pool)` instead — OLS `rebalance` routes
 *     ERC20 transfers from `msg.sender`, which always reverts inside ERC20
 *     when called with `address(0)`.
 *   - unknown: skip without emitting a metric — better than a misleading
 *     "blocked" annotation in the Slack alert.
 *
 * Healthy no-op codes (pool below threshold) collapse to `ok` so the alert
 * doesn't render "blocked" for a pool that's mid-recovery.
 */
export async function probeRebalance(
  client: PublicClient,
  poolAddress: `0x${string}`,
  strategyAddress: `0x${string}`,
): Promise<RebalanceProbeResult> {
  let strategyType: StrategyType;
  try {
    strategyType = await detectStrategyType(
      client,
      strategyAddress,
      poolAddress,
    );
  } catch (err: unknown) {
    return {
      kind: "transport_error",
      error: extractRawMessage(err) ?? "transport error",
    };
  }

  if (strategyType === "unknown") {
    return {
      kind: "skip",
      reason: "Unable to identify the liquidity strategy type",
    };
  }

  // OLS rebalance() transfers tokens to/from msg.sender, so simulating from
  // address(0) always reverts inside ERC20 — meaningless. Use determineAction
  // (view-only) instead for OLS. CDP/Reserve source tokens from the strategy
  // contract itself, so the rebalance() simulation from address(0) is valid.
  const probeFn = strategyType === "ols" ? "determineAction" : "rebalance";

  try {
    await client.call({
      to: strategyAddress,
      data: encodeFunctionData({
        abi: STRATEGY_ABI,
        functionName: probeFn,
        args: [poolAddress],
      }),
    });
    return { kind: "ok" };
  } catch (err: unknown) {
    if (!isContractRevert(err)) {
      return {
        kind: "transport_error",
        error: extractRawMessage(err) ?? "transport error",
      };
    }
    return decodeBlockedRevert(err);
  }
}

function decodeBlockedRevert(err: unknown): RebalanceProbeResult {
  const revertData = extractRevertData(err);
  if (!revertData) {
    return {
      kind: "blocked",
      reasonCode: "unknown",
      reasonMessage: "Rebalance reverted with an unknown error",
    };
  }

  let errorName: string;
  let errorArgs: readonly unknown[] | undefined;
  try {
    const decoded = decodeErrorResult({ abi: STRATEGY_ABI, data: revertData });
    errorName = decoded.errorName;
    errorArgs = decoded.args;
  } catch {
    return {
      kind: "blocked",
      reasonCode: "unknown",
      reasonMessage: `Unrecognized revert (${truncateHex(revertData)})`,
    };
  }

  // A healthy pool's strategy refused to rebalance — collapse to ok so the
  // alert doesn't paint a deceptive "blocked" line.
  if (HEALTHY_NO_OP_ERRORS.has(errorName)) {
    return { kind: "ok" };
  }

  // Built-in Solidity reverts (Error / Panic) don't carry meaningful names.
  // Surface the embedded message / panic code instead.
  if (errorName === "Error" && typeof errorArgs?.[0] === "string") {
    return {
      kind: "blocked",
      reasonCode: "Error",
      reasonMessage: `Reverted: ${truncateString(errorArgs[0])}`,
    };
  }
  if (errorName === "Panic" && typeof errorArgs?.[0] === "bigint") {
    return {
      kind: "blocked",
      reasonCode: "Panic",
      reasonMessage: `Panicked (code 0x${errorArgs[0].toString(16)})`,
    };
  }

  return {
    kind: "blocked",
    reasonCode: errorName,
    reasonMessage:
      ERROR_MESSAGES[errorName] ?? `Rebalance reverted: ${errorName}`,
  };
}

/**
 * Heuristic: contract reverts contain revert data or "execution reverted" /
 * "returned no data" in the message. Transport errors (fetch failures, 401,
 * timeouts) do not match either branch.
 *
 * Mirror of the dashboard's `isContractRevert` (`rebalance-check.ts:432`) so
 * both probes classify the same way.
 */
function isContractRevert(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (extractRevertData(err)) return true;
  const msg = (err as { message?: string }).message ?? "";
  return /revert|returned no data/i.test(msg);
}

function extractRevertData(err: unknown): Hex | null {
  if (err && typeof err === "object") {
    let current: Record<string, unknown> = err as Record<string, unknown>;
    for (let i = 0; i < 5; i++) {
      if (typeof current.data === "string" && current.data.startsWith("0x")) {
        return current.data as Hex;
      }
      if (
        current.data &&
        typeof current.data === "object" &&
        typeof (current.data as Record<string, unknown>).data === "string"
      ) {
        const nested = (current.data as Record<string, unknown>).data as string;
        if (nested.startsWith("0x")) return nested as Hex;
      }
      if (current.cause && typeof current.cause === "object") {
        current = current.cause as Record<string, unknown>;
      } else {
        break;
      }
    }
  }
  return null;
}

function extractRawMessage(err: unknown): string | null {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/** Slack alert label values are user-visible — keep them concise. */
function truncateString(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function truncateHex(hex: Hex, max = 18): string {
  return hex.length > max ? `${hex.slice(0, max - 1)}…` : hex;
}
