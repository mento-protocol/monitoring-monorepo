/**
 * Rebalance feasibility checker.
 *
 * Simulates a rebalance call on the pool's liquidity strategy via eth_call,
 * decodes any revert, and optionally enriches with strategy-specific state
 * (e.g. stability pool balance, reserve collateral).
 *
 * Canonical ABI + error map live in
 * `@mento-protocol/monitoring-config/rebalance-abi` — both this probe and
 * the metrics-bridge alert probe import the same data so a revert decoded
 * by one always decodes by the other.
 */

import {
  decodeErrorResult,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  parseAbi,
} from "viem";
import {
  STRATEGY_ABI_SOURCES,
  ERROR_MESSAGES,
  HEALTHY_NO_OP_ERRORS,
  REASON_CODES,
} from "@mento-protocol/monitoring-config/rebalance-abi";
import { POOL_PAIR_ABI_SOURCES } from "@mento-protocol/monitoring-config/erc20-abi";
import {
  fetchReserveEnrichment as fetchReserveEnrichmentShared,
  type EnrichmentRpc,
} from "@mento-protocol/monitoring-config/rebalance-enrichment";
import { toHumanUnits } from "@mento-protocol/monitoring-config/units";
import { getViemClient, ERC20_ABI } from "./rpc-client";

// Re-export so existing dashboard call sites (chart tooltips, etc.) keep
// importing from one canonical location without each migrating to the
// shared-config path individually.
export { toHumanUnits };

// ABI fragments

/** Both ReserveLiquidityStrategy and CDPLiquidityStrategy share this */
const STRATEGY_ABI = parseAbi(STRATEGY_ABI_SOURCES);

const STABILITY_POOL_ABI = parseAbi([
  "function getTotalBoldDeposits() external view returns (uint256)",
  "function boldToken() external view returns (address)",
]);

// Note: ReserveV2 does not expose a collateral balance getter — we use
// ERC20 balanceOf on the collateral token with the reserve address instead.

// Types

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

// Healthy no-op detection — the bare-set lookup happens against
// `HEALTHY_NO_OP_ERRORS` from `shared-config/rebalance-abi`, where the
// rationale comment lives.

export function isHealthyNoOp(rawError: string | null | undefined): boolean {
  return rawError != null && HEALTHY_NO_OP_ERRORS.has(rawError);
}

// Explorer deep-link for rebalance()

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

// Core check

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

// Strategy type detection

export async function detectStrategyType(
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

// Revert handling + enrichment

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
  } else if (errorName in ERROR_MESSAGES) {
    humanMessage = ERROR_MESSAGES[errorName as keyof typeof ERROR_MESSAGES];
  } else {
    humanMessage = `Rebalance reverted: ${errorName}`;
  }

  // Fetch enrichment data for specific errors. Compares against
  // `REASON_CODES.*` rather than bare string literals so a typo here would
  // be a compile error — the same error-code constants flow through the
  // metrics-bridge probe, keeping enrichment selection in lockstep across
  // the dashboard and the Slack alert.
  let enrichment: StrategyEnrichment | null = null;
  if (
    strategyType === "cdp" &&
    errorName === REASON_CODES.CDPLS_STABILITY_POOL_BALANCE_TOO_LOW
  ) {
    enrichment = await fetchCDPEnrichment(client, strategy, pool);
  } else if (
    strategyType === "reserve" &&
    errorName === REASON_CODES.RLS_RESERVE_OUT_OF_COLLATERAL
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

// Strategy-specific enrichment

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

/**
 * Adapter from a viem `PublicClient` to the `EnrichmentRpc` shape consumed
 * by `@mento-protocol/monitoring-config/rebalance-enrichment`. Each method
 * is a thin viem wrapper — shared-config stays viem-free, the orchestration
 * (parallel pool-token reads, debt-leg pick, balance/decimals fetch) lives
 * in shared-config.
 */
const POOL_PAIR_ABI = parseAbi(POOL_PAIR_ABI_SOURCES);

function makeEnrichmentRpc(client: PublicClient): EnrichmentRpc {
  return {
    async readDetermineAction({ strategy, pool }) {
      // Dashboard never uses needed-mode (calls `fetchReserveEnrichment` in
      // balance-only mode), but the EnrichmentRpc surface requires both.
      // Stub kept so a future tooltip variant can switch modes.
      const [ctx, action] = (await client.readContract({
        address: strategy,
        abi: STRATEGY_ABI,
        functionName: "determineAction",
        args: [pool],
      })) as readonly [{ isToken0Debt: boolean }, { amountOwedToPool: bigint }];
      return {
        isToken0Debt: ctx.isToken0Debt,
        amountOwedToPool: action.amountOwedToPool,
      };
    },
    async readPoolConfigs({ strategy, pool }) {
      const cfg = (await client.readContract({
        address: strategy,
        abi: STRATEGY_ABI,
        functionName: "poolConfigs",
        args: [pool],
      })) as readonly [boolean, ...unknown[]];
      return { isToken0Debt: cfg[0] };
    },
    async readPoolTokens(pool) {
      const [token0, token1] = await Promise.all([
        client.readContract({
          address: pool,
          abi: POOL_PAIR_ABI,
          functionName: "token0",
        }),
        client.readContract({
          address: pool,
          abi: POOL_PAIR_ABI,
          functionName: "token1",
        }),
      ]);
      return {
        token0: token0 as `0x${string}`,
        token1: token1 as `0x${string}`,
      };
    },
    async readBalanceOf({ token, holder }) {
      return (await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [holder],
      })) as bigint;
    },
  };
}

async function fetchReserveEnrichment(
  client: PublicClient,
  strategy: `0x${string}`,
  pool: `0x${string}`,
): Promise<StrategyEnrichment | null> {
  // Resolve `reserve()` first — needed by the shared helper as a parameter,
  // and the dashboard doesn't carry it through from detection (unlike the
  // metrics-bridge probe, which threads it through to save one RPC).
  let reserveAddr: `0x${string}`;
  try {
    reserveAddr = (await client.readContract({
      address: strategy,
      abi: STRATEGY_ABI,
      functionName: "reserve",
    })) as `0x${string}`;
  } catch {
    return null;
  }

  const result = await fetchReserveEnrichmentShared(
    makeEnrichmentRpc(client),
    strategy,
    pool,
    {
      chainId: 0, // Dashboard doesn't pre-resolve via manifest; symbol/decimals come from on-chain reads via the resolvers below.
      reserveAddr,
      mode: "balance-only",
      resolveSymbol: async (_chainId, addr) => {
        try {
          return (await client.readContract({
            address: addr,
            abi: ERC20_ABI,
            functionName: "symbol",
          })) as string;
        } catch {
          return null;
        }
      },
      resolveDecimals: async (_chainId, addr) => {
        const decimals = (await client.readContract({
          address: addr,
          abi: ERC20_ABI,
          functionName: "decimals",
        })) as number;
        return Number(decimals);
      },
    },
  );
  if (result === null || result.tokenSymbol === null) return null;
  return {
    type: "reserve",
    reserveCollateralBalance: result.balance,
    collateralTokenSymbol: result.tokenSymbol,
    collateralTokenDecimals: result.decimals,
  };
}
