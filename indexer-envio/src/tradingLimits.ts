// ---------------------------------------------------------------------------
// Trading limit types and computation
// ---------------------------------------------------------------------------

import type { TradingLimit } from "envio";

/** TradingLimitsV2 stores all limit/netflow values in 15-decimal internal precision. */
export const TRADING_LIMITS_INTERNAL_DECIMALS = 15;

const L0_WINDOW_SECONDS = 5n * 60n;
const L1_WINDOW_SECONDS = 24n * 60n * 60n;
const BASIS_POINTS_DENOMINATOR = 10_000n;

export type TradingLimitConfig = {
  limit0: bigint;
  limit1: bigint;
  /** Token decimals from the FPMM contract config, not the entity display decimals. */
  decimals: number;
};

export type TradingLimitState = {
  lastUpdated0: bigint;
  lastUpdated1: bigint;
  netflow0: bigint;
  netflow1: bigint;
};

export type TradingLimitData = {
  config: TradingLimitConfig;
  state: {
    lastUpdated0: number;
    lastUpdated1: number;
    netflow0: bigint;
    netflow1: bigint;
  };
};

export function tradingLimitId(poolId: string, token: string): string {
  return `${poolId}-${token}`;
}

export function tradingLimitStateFromEntity(
  row: Pick<
    TradingLimit,
    "lastUpdated0" | "lastUpdated1" | "netflow0" | "netflow1"
  >,
): TradingLimitState {
  return {
    lastUpdated0: row.lastUpdated0,
    lastUpdated1: row.lastUpdated1,
    netflow0: row.netflow0,
    netflow1: row.netflow1,
  };
}

export function tradingLimitConfigFromEntity(
  row: Pick<TradingLimit, "limit0" | "limit1">,
  tokenDecimals: number,
): TradingLimitConfig {
  return {
    limit0: row.limit0,
    limit1: row.limit1,
    decimals: tokenDecimals,
  };
}

export function resetTradingLimitState(
  state: TradingLimitState | undefined,
  config: Pick<TradingLimitConfig, "limit0" | "limit1">,
): TradingLimitState {
  return {
    lastUpdated0: 0n,
    lastUpdated1: 0n,
    netflow0: config.limit0 === 0n ? 0n : (state?.netflow0 ?? 0n),
    netflow1: config.limit1 === 0n ? 0n : (state?.netflow1 ?? 0n),
  };
}

export function scaleTradingLimitValue(
  value: bigint,
  tokenDecimals: number,
): bigint {
  if (value === 0n) return 0n;
  return (
    (value * 10n ** BigInt(TRADING_LIMITS_INTERNAL_DECIMALS)) /
    10n ** BigInt(tokenDecimals)
  );
}

export function applyTradingLimitSwap(
  state: TradingLimitState,
  config: TradingLimitConfig,
  args: {
    amountIn: bigint;
    amountOut: bigint;
    totalFeeBps: number;
    blockTimestamp: bigint;
  },
): TradingLimitState {
  if (config.limit0 === 0n && config.limit1 === 0n) return state;

  const scaledAmountIn = scaleTradingLimitValue(args.amountIn, config.decimals);
  const scaledAmountOut = scaleTradingLimitValue(
    args.amountOut,
    config.decimals,
  );
  const amountInAfterFees =
    scaledAmountIn -
    (scaledAmountIn * BigInt(args.totalFeeBps)) / BASIS_POINTS_DENOMINATOR;
  const deltaFlow = amountInAfterFees - scaledAmountOut;
  if (deltaFlow === 0n) return state;

  const next = { ...state };
  if (config.limit0 > 0n) {
    if (args.blockTimestamp > next.lastUpdated0 + L0_WINDOW_SECONDS) {
      next.netflow0 = 0n;
      next.lastUpdated0 = args.blockTimestamp;
    }
    next.netflow0 += deltaFlow;
  }
  if (config.limit1 > 0n) {
    if (args.blockTimestamp > next.lastUpdated1 + L1_WINDOW_SECONDS) {
      next.netflow1 = 0n;
      next.lastUpdated1 = args.blockTimestamp;
    }
    next.netflow1 += deltaFlow;
  }
  return next;
}

export function isKnownFeeState(
  pool: Pick<
    {
      lpFee: number;
      protocolFee: number;
    },
    "lpFee" | "protocolFee"
  >,
): boolean {
  return pool.lpFee >= 0 && pool.protocolFee >= 0;
}

export function buildTradingLimitEntity(args: {
  id: string;
  chainId: number;
  poolId: string;
  token: string;
  config: Pick<TradingLimitConfig, "limit0" | "limit1">;
  state: TradingLimitState;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): TradingLimit {
  const { p0, p1 } = computeLimitPressures(
    args.state.netflow0,
    args.state.netflow1,
    args.config.limit0,
    args.config.limit1,
  );
  return {
    id: args.id,
    chainId: args.chainId,
    poolId: args.poolId,
    token: args.token,
    limit0: args.config.limit0,
    limit1: args.config.limit1,
    // UI formats all TradingLimitsV2 values in the library's internal scale.
    decimals: TRADING_LIMITS_INTERNAL_DECIMALS,
    netflow0: args.state.netflow0,
    netflow1: args.state.netflow1,
    lastUpdated0: args.state.lastUpdated0,
    lastUpdated1: args.state.lastUpdated1,
    limitPressure0: p0.toFixed(4),
    limitPressure1: p1.toFixed(4),
    limitStatus: computeLimitStatus(p0, p1),
    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.blockTimestamp,
  };
}

export function buildTradingLimitEntityFromRpc(args: {
  id: string;
  chainId: number;
  poolId: string;
  token: string;
  data: TradingLimitData;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): TradingLimit {
  return buildTradingLimitEntity({
    id: args.id,
    chainId: args.chainId,
    poolId: args.poolId,
    token: args.token,
    config: args.data.config,
    state: {
      lastUpdated0: BigInt(args.data.state.lastUpdated0),
      lastUpdated1: BigInt(args.data.state.lastUpdated1),
      netflow0: args.data.state.netflow0,
      netflow1: args.data.state.netflow1,
    },
    blockNumber: args.blockNumber,
    blockTimestamp: args.blockTimestamp,
  });
}

export function computeLimitStatus(p0: number, p1: number): string {
  const worst = Math.max(p0, p1);
  if (worst >= 1.0) return "CRITICAL";
  if (worst > 0.8) return "WARN";
  return "OK";
}

export function computeLimitPressures(
  netflow0: bigint,
  netflow1: bigint,
  limit0: bigint,
  limit1: bigint,
): { p0: number; p1: number } {
  const abs0 = netflow0 < 0n ? -netflow0 : netflow0;
  const abs1 = netflow1 < 0n ? -netflow1 : netflow1;
  const p0 = limit0 !== 0n ? Number(abs0) / Number(limit0) : 0;
  const p1 = limit1 !== 0n ? Number(abs1) / Number(limit1) : 0;
  return { p0, p1 };
}
