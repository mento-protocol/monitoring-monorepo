/**
 * Rebalance feasibility checker.
 *
 * Simulates a rebalance call on the pool's liquidity strategy via eth_call,
 * decodes any revert, and optionally enriches with strategy-specific state
 * (e.g. stability pool balance, reserve collateral).
 */

import {
  decodeErrorResult,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { getViemClient, ERC20_ABI } from "./rpc-client";

// ---------------------------------------------------------------------------
// ABI fragments
// ---------------------------------------------------------------------------

/** Both ReserveLiquidityStrategy and CDPLiquidityStrategy share this */
const STRATEGY_ABI = parseAbi([
  // Shared
  "function rebalance(address pool) external",
  "function determineAction(address pool) external view returns ((address pool, uint256 reserveNumerator, uint256 reserveDenominator, uint256 oraclePriceNumerator, uint256 oraclePriceDenominator, bool reservePriceAboveOraclePrice, uint16 rebalanceThreshold, address token0, address token1, uint8 decimals0, uint8 decimals1, bool isToken0Debt, uint64 liquiditySourceIncentiveExpansion, uint64 protocolIncentiveExpansion, uint64 liquiditySourceIncentiveContraction, uint64 protocolIncentiveContraction) ctx, (uint8 direction, uint256 amount0Out, uint256 amount1Out, uint256 amountOwedToPool) action)",
  "function poolConfigs(address pool) external view returns (bool isToken0Debt, uint32 lastRebalance, uint32 rebalanceCooldown, address protocolFeeRecipient, uint64 liquiditySourceIncentiveExpansion, uint64 protocolIncentiveExpansion, uint64 liquiditySourceIncentiveContraction, uint64 protocolIncentiveContraction)",
  // CDPLiquidityStrategy-specific
  "function getCDPConfig(address pool) external view returns ((address stabilityPool, address collateralRegistry, uint256 stabilityPoolPercentage, uint256 maxIterations))",
  // ReserveLiquidityStrategy-specific
  "function reserve() external view returns (address)",
  // OpenLiquidityStrategy-specific — used only for strategy-type detection.
  // getPools() is zero-arg so the probe is cheap and OLS-exclusive.
  "function getPools() external view returns (address[])",
  // Errors — shared (LS_*)
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
  // CDPLiquidityStrategy errors
  "error CDPLS_COLLATERAL_REGISTRY_IS_ZERO()",
  "error CDPLS_INVALID_STABILITY_POOL_PERCENTAGE()",
  "error CDPLS_OUT_OF_FUNDS_FOR_REDEMPTION_SUBSIDY()",
  "error CDPLS_REDEMPTION_FEE_TOO_LARGE()",
  "error CDPLS_REDEMPTION_SHORTFALL_TOO_LARGE(uint256 shortfall)",
  "error CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()",
  "error CDPLS_STABILITY_POOL_IS_ZERO()",
  // ReserveLiquidityStrategy errors
  "error RLS_COLLATERAL_TO_POOL_FAILED()",
  "error RLS_INVALID_RESERVE()",
  "error RLS_RESERVE_OUT_OF_COLLATERAL()",
  "error RLS_TOKEN_IN_NOT_SUPPORTED()",
  "error RLS_TOKEN_OUT_NOT_SUPPORTED()",
  // OpenLiquidityStrategy errors
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
]);

const STABILITY_POOL_ABI = parseAbi([
  "function getTotalBoldDeposits() external view returns (uint256)",
  "function boldToken() external view returns (address)",
]);

// Note: ReserveV2 does not expose a collateral balance getter — we use
// ERC20 balanceOf on the collateral token with the reserve address instead.

// ---------------------------------------------------------------------------
// Error → human-readable message mapping
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StrategyType = "cdp" | "reserve" | "ols" | "unknown";

export type RebalanceCheckResult = {
  canRebalance: boolean;
  /** Human-readable explanation */
  message: string;
  /** Raw Solidity error name (e.g. "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW") */
  rawError: string | null;
  /** Detected strategy type */
  strategyType: StrategyType;
  /** Strategy-specific enrichment data */
  enrichment: StrategyEnrichment | null;
};

export type StrategyEnrichment =
  | {
      type: "cdp";
      /** Total deposits available in the stability pool (human units) */
      stabilityPoolBalance: number;
      /** Symbol of the token in the stability pool */
      stabilityPoolTokenSymbol: string;
      /** Decimals of the stability pool token */
      stabilityPoolTokenDecimals: number;
    }
  | {
      type: "reserve";
      /** Collateral balance available in the reserve (human units) */
      reserveCollateralBalance: number;
      /** Symbol of the collateral token */
      collateralTokenSymbol: string;
      /** Decimals of the collateral token */
      collateralTokenDecimals: number;
    };

// ---------------------------------------------------------------------------
// Healthy no-op detection
// ---------------------------------------------------------------------------

/**
 * Revert codes where the strategy refuses to rebalance BECAUSE the pool
 * is healthy — not because anything is wrong. Callers should treat these
 * as passive "no action needed" states rather than rendering a red
 * "Rebalance blocked" alarm.
 *
 * Both the strategy-side (`LS_POOL_NOT_REBALANCEABLE`) and pool-side
 * (`PriceDifferenceTooSmall`) codes map to "deviation is below the
 * rebalance threshold" — the expected healthy outcome, especially at
 * exactly-threshold deviation under the `> threshold` CRITICAL semantics.
 */
const HEALTHY_NO_OP_ERRORS: ReadonlySet<string> = new Set([
  "LS_POOL_NOT_REBALANCEABLE",
  "PriceDifferenceTooSmall",
]);

export function isHealthyNoOp(rawError: string | null | undefined): boolean {
  return rawError != null && HEALTHY_NO_OP_ERRORS.has(rawError);
}

// ---------------------------------------------------------------------------
// Explorer deep-link for rebalance()
// ---------------------------------------------------------------------------

/**
 * Deep-link into the explorer's proxy-write tab for the strategy.
 *
 * Avoid row-index anchors like `#F4`: explorer ABI ordering is not a stable
 * contract, and different strategy implementations/proxies can shift function
 * positions while still exposing rebalance(address).
 */
export function strategyRebalanceWriteUrl(
  explorerBaseUrl: string,
  strategyAddress: string,
): string {
  return `${explorerBaseUrl}/address/${strategyAddress}#writeProxyContract`;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Simulate a rebalance and return a diagnostic result.
 * Only call this when the pool actually needs rebalancing (health != OK).
 */
export async function checkRebalanceStatus(
  poolAddress: string,
  strategyAddress: string,
  rpcUrl: string,
): Promise<RebalanceCheckResult> {
  const client = getViemClient(rpcUrl);
  const pool = poolAddress as `0x${string}`;
  const strategy = strategyAddress as `0x${string}`;

  // 1. Detect strategy type — if detection itself fails with a transport error
  //    (network down, 401, etc.) let it propagate so SWR surfaces it via the
  //    error state ("Diagnostics unavailable").
  const strategyType = await detectStrategyType(client, strategy, pool);

  // Refuse to simulate against an unrecognised strategy — eth_call to an EOA
  // or zero-code address silently returns 0x, which would be a false positive.
  if (strategyType === "unknown") {
    return {
      canRebalance: false,
      message: "Unable to identify the liquidity strategy type",
      rawError: null,
      strategyType,
      enrichment: null,
    };
  }

  // 2. Probe the strategy. OLS rebalance() transfers tokens to/from msg.sender,
  //    so simulating from address(0) always reverts inside ERC20 — meaningless.
  //    Use determineAction(pool) instead, which is view-only and handles the
  //    zero-sender path explicitly in _clampExpansion/_clampContraction.
  //    CDP/Reserve source tokens from the strategy contract itself, so the
  //    rebalance() simulation from address(0) is valid for them.
  const probeFn = strategyType === "ols" ? "determineAction" : "rebalance";

  try {
    await client.call({
      to: strategy,
      data: encodeFunctionData({
        abi: STRATEGY_ABI,
        functionName: probeFn,
        args: [pool],
      }),
    });

    // If we reach here, the probe succeeded.
    return {
      canRebalance: true,
      message: "Rebalance is currently possible",
      rawError: null,
      strategyType,
      enrichment: null,
    };
  } catch (err: unknown) {
    // Distinguish contract reverts (which contain revert data) from transport
    // errors (network failures, 401s, timeouts). Only contract reverts should
    // be decoded — transport errors must propagate so SWR shows the
    // "Diagnostics unavailable" state instead of a misleading "blocked".
    if (!isContractRevert(err)) {
      throw err;
    }
    return handleRevert(err, client, strategy, pool, strategyType);
  }
}

// ---------------------------------------------------------------------------
// Strategy type detection
// ---------------------------------------------------------------------------

async function detectStrategyType(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<StrategyType> {
  // Try CDP first (getCDPConfig is unique to CDPLiquidityStrategy).
  // Only swallow contract-level reverts (wrong ABI / function not found).
  // Transport errors (network, 401, CORS) must propagate so SWR shows
  // "Diagnostics unavailable" instead of a misleading "unknown strategy".
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

  // OLS probe — getPools() is OLS-exclusive and zero-arg, so the selector alone
  // is enough to distinguish from CDP / Reserve strategies.
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

// ---------------------------------------------------------------------------
// Revert handling + enrichment
// ---------------------------------------------------------------------------

async function handleRevert(
  err: unknown,
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
  strategyType: StrategyType,
): Promise<RebalanceCheckResult> {
  // Extract the revert data from the RPC error
  const revertData = extractRevertData(err);

  if (!revertData) {
    return {
      canRebalance: false,
      message: "Rebalance reverted with an unknown error",
      rawError: extractRawMessage(err),
      strategyType,
      enrichment: null,
    };
  }

  // Decode the custom error
  let errorName: string;
  let errorArgs: readonly unknown[] | undefined;
  try {
    const decoded = decodeErrorResult({
      abi: STRATEGY_ABI,
      data: revertData,
    });
    errorName = decoded.errorName;
    errorArgs = decoded.args;
  } catch {
    return {
      canRebalance: false,
      message: "Rebalance reverted with an unrecognized error",
      rawError: revertData,
      strategyType,
      enrichment: null,
    };
  }

  // Built-in Solidity reverts don't carry a meaningful error name — surface
  // the embedded message/code instead of "Rebalance reverted: Error".
  let humanMessage: string;
  if (errorName === "Error" && typeof errorArgs?.[0] === "string") {
    humanMessage = `Rebalance reverted: ${errorArgs[0]}`;
  } else if (errorName === "Panic" && typeof errorArgs?.[0] === "bigint") {
    humanMessage = `Rebalance panicked (code 0x${errorArgs[0].toString(16)})`;
  } else {
    humanMessage =
      ERROR_MESSAGES[errorName] ?? `Rebalance reverted: ${errorName}`;
  }

  // Fetch enrichment data for specific errors
  let enrichment: StrategyEnrichment | null = null;
  if (
    strategyType === "cdp" &&
    errorName === "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW"
  ) {
    enrichment = await fetchCDPEnrichment(client, strategy, pool);
  } else if (
    strategyType === "reserve" &&
    errorName === "RLS_RESERVE_OUT_OF_COLLATERAL"
  ) {
    enrichment = await fetchReserveEnrichment(client, strategy, pool);
  }

  // Suppress noisy "[Error]" / "[Panic]" tags on the UI — for built-in reverts
  // the meaningful bit is already embedded in `message`.
  const isBuiltInRevert = errorName === "Error" || errorName === "Panic";

  return {
    canRebalance: false,
    message: humanMessage,
    rawError: isBuiltInRevert ? null : errorName,
    strategyType,
    enrichment,
  };
}

/** Heuristic: contract reverts contain revert data or "execution reverted" in
 *  the message. Transport/network errors (fetch failures, 401, timeouts,
 *  "execution timeout") do not match. */
function isContractRevert(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Walk the cause chain looking for revert data
  if (extractRevertData(err)) return true;
  // Viem tags contract reverts with "revert" — match that specifically,
  // but NOT loose "execution" which also appears in provider-level errors
  // like "execution timeout" or "execution aborted".
  //
  // `returned no data ("0x")` covers viem's no-code / wrong-ABI path
  // (ContractFunctionZeroDataError) — we want to treat "contract doesn't
  // implement this function" the same as an explicit revert for probe
  // purposes so EOAs / misconfigured strategy addresses land in the
  // neutral "Unable to identify" fallback instead of bubbling up as a
  // transport-level "Diagnostics unavailable".
  const msg = (err as { message?: string }).message ?? "";
  return /revert|returned no data/i.test(msg);
}

function extractRevertData(err: unknown): Hex | null {
  if (err && typeof err === "object") {
    // Viem wraps call reverts in a ContractFunctionExecutionError
    // with a nested cause chain. Walk the chain to find revert data.
    let current: Record<string, unknown> = err as Record<string, unknown>;
    for (let i = 0; i < 5; i++) {
      if (typeof current.data === "string" && current.data.startsWith("0x")) {
        return current.data as Hex;
      }
      // Some providers wrap revert data as { data: { data: "0x..." } }
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

// ---------------------------------------------------------------------------
// Strategy-specific enrichment
// ---------------------------------------------------------------------------

/**
 * Convert a raw on-chain uint256 balance to a human-units number without
 * losing precision when the raw value exceeds 2^53. `Number(bigint) /
 * 10**decimals` truncates bits past 2^53, which for an 18-decimal token
 * kicks in around 9M whole tokens — well within realistic supplies. We
 * scale down in BigInt first so the Number cast is always safe.
 *
 * Fractional precision is capped at 6 digits (far more than the tooltip
 * needs) to keep the final Number representation lossless.
 */
export function toHumanUnits(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  // BigInt(...) call form rather than `10n` literal — the ui-dashboard
  // tsconfig targets ES2017, which doesn't emit BigInt literals.
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = raw / divisor;
  const fractionScale = BigInt(1_000_000);
  const fraction = ((raw % divisor) * fractionScale) / divisor;
  return Number(whole) + Number(fraction) / Number(fractionScale);
}

async function fetchCDPEnrichment(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<StrategyEnrichment | null> {
  try {
    const config = await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getCDPConfig",
      args: [pool],
    });

    const stabilityPoolAddr = config.stabilityPool as `0x${string}`;

    const [totalDeposits, boldToken] = await Promise.all([
      client.readContract({
        address: stabilityPoolAddr,
        abi: STABILITY_POOL_ABI,
        functionName: "getTotalBoldDeposits",
      }),
      client.readContract({
        address: stabilityPoolAddr,
        abi: STABILITY_POOL_ABI,
        functionName: "boldToken",
      }),
    ]);

    const [symbol, decimals] = await Promise.all([
      client.readContract({
        address: boldToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      client.readContract({
        address: boldToken as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ]);

    return {
      type: "cdp",
      stabilityPoolBalance: toHumanUnits(
        totalDeposits as bigint,
        Number(decimals),
      ),
      stabilityPoolTokenSymbol: symbol as string,
      stabilityPoolTokenDecimals: Number(decimals),
    };
  } catch {
    return null;
  }
}

async function fetchReserveEnrichment(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<StrategyEnrichment | null> {
  try {
    const reserveAddr = (await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "reserve",
    })) as `0x${string}`;

    // Determine the collateral token — it's the non-debt token.
    // Read pool config to know which token is debt.
    const poolConfig = await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "poolConfigs",
      args: [pool],
    });

    const isToken0Debt = poolConfig[0] as boolean;

    // Read pool tokens
    const poolAbi = parseAbi([
      "function token0() external view returns (address)",
      "function token1() external view returns (address)",
    ]);
    const [token0, token1] = await Promise.all([
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "token0",
      }),
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "token1",
      }),
    ]);

    const collateralToken = (isToken0Debt ? token1 : token0) as `0x${string}`;

    const balanceOfAbi = parseAbi([
      "function balanceOf(address account) external view returns (uint256)",
    ]);

    const [balance, symbol, decimals] = await Promise.all([
      client.readContract({
        address: collateralToken,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: [reserveAddr],
      }),
      client.readContract({
        address: collateralToken,
        abi: ERC20_ABI,
        functionName: "symbol",
      }),
      client.readContract({
        address: collateralToken,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ]);

    return {
      type: "reserve",
      reserveCollateralBalance: toHumanUnits(
        balance as bigint,
        Number(decimals),
      ),
      collateralTokenSymbol: symbol as string,
      collateralTokenDecimals: Number(decimals),
    };
  } catch {
    return null;
  }
}
