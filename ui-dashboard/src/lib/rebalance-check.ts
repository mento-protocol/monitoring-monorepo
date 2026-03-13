/**
 * Rebalance feasibility checker.
 *
 * Simulates a rebalance call on the pool's liquidity strategy via eth_call,
 * decodes any revert, and optionally enriches with strategy-specific state
 * (e.g. stability pool balance, reserve collateral).
 */

import {
  createPublicClient,
  http,
  decodeErrorResult,
  type Hex,
  encodeFunctionData,
  parseAbi,
} from "viem";

// ---------------------------------------------------------------------------
// RPC client per chain (cached)
// ---------------------------------------------------------------------------

const RPC_URLS: Record<number, string> = {
  42220: process.env.NEXT_PUBLIC_RPC_URL_CELO ?? "https://forno.celo.org",
  11142220:
    process.env.NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA ??
    "https://alfajores-forno.celo-testnet.org",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientCache = new Map<number, any>();

function getClient(chainId: number) {
  let client = clientCache.get(chainId);
  if (client) return client;
  const rpcUrl = RPC_URLS[chainId];
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain ${chainId}`);
  client = createPublicClient({
    transport: http(rpcUrl),
  });
  clientCache.set(chainId, client);
  return client;
}

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
]);

const STABILITY_POOL_ABI = parseAbi([
  "function getTotalBoldDeposits() external view returns (uint256)",
  "function boldToken() external view returns (address)",
]);

const RESERVE_ABI = parseAbi([
  "function getReserveAddressesCollateralAssetBalance(address collateral) external view returns (uint256)",
]);

const ERC20_ABI = parseAbi([
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
]);

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
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StrategyType = "cdp" | "reserve" | "unknown";

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
// Core check
// ---------------------------------------------------------------------------

/**
 * Simulate a rebalance and return a diagnostic result.
 * Only call this when the pool actually needs rebalancing (health != OK).
 */
export async function checkRebalanceStatus(
  poolAddress: string,
  strategyAddress: string,
  chainId: number,
): Promise<RebalanceCheckResult> {
  const client = getClient(chainId);
  const pool = poolAddress as `0x${string}`;
  const strategy = strategyAddress as `0x${string}`;

  // 1. Detect strategy type
  const strategyType = await detectStrategyType(client, strategy, pool);

  // 2. Simulate rebalance(pool) via eth_call
  try {
    await client.call({
      to: strategy,
      data: encodeFunctionData({
        abi: STRATEGY_ABI,
        functionName: "rebalance",
        args: [pool],
      }),
    });

    // If we reach here, rebalance would succeed
    return {
      canRebalance: true,
      message: "Rebalance is currently possible",
      rawError: null,
      strategyType,
      enrichment: null,
    };
  } catch (err: unknown) {
    return handleRevert(err, client, strategy, pool, strategyType);
  }
}

// ---------------------------------------------------------------------------
// Strategy type detection
// ---------------------------------------------------------------------------

async function detectStrategyType(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<StrategyType> {
  // Try CDP first (getCDPConfig is unique to CDPLiquidityStrategy)
  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "getCDPConfig",
      args: [pool],
    });
    return "cdp";
  } catch {
    // Not CDP — try Reserve
  }

  try {
    await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "reserve",
    });
    return "reserve";
  } catch {
    // Neither
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Revert handling + enrichment
// ---------------------------------------------------------------------------

async function handleRevert(
  err: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
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
  try {
    const decoded = decodeErrorResult({
      abi: STRATEGY_ABI,
      data: revertData,
    });
    errorName = decoded.errorName;
  } catch {
    return {
      canRebalance: false,
      message: "Rebalance reverted with an unrecognized error",
      rawError: revertData,
      strategyType,
      enrichment: null,
    };
  }

  const humanMessage =
    ERROR_MESSAGES[errorName] ?? `Rebalance reverted: ${errorName}`;

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

  return {
    canRebalance: false,
    message: humanMessage,
    rawError: errorName,
    strategyType,
    enrichment,
  };
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

async function fetchCDPEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
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
      stabilityPoolBalance:
        Number(totalDeposits as bigint) / 10 ** Number(decimals),
      stabilityPoolTokenSymbol: symbol as string,
      stabilityPoolTokenDecimals: Number(decimals),
    };
  } catch {
    return null;
  }
}

async function fetchReserveEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
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

    const [balance, symbol, decimals] = await Promise.all([
      client.readContract({
        address: reserveAddr,
        abi: RESERVE_ABI,
        functionName: "getReserveAddressesCollateralAssetBalance",
        args: [collateralToken],
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
      reserveCollateralBalance:
        Number(balance as bigint) / 10 ** Number(decimals),
      collateralTokenSymbol: symbol as string,
      collateralTokenDecimals: Number(decimals),
    };
  } catch {
    return null;
  }
}
