import type {
  PegStructuralPoolRow,
  PegSwapEventRow,
  PegTradingLimitRow,
} from "./graphql.js";

export const TRADING_LIMIT_INTERNAL_DECIMALS = 15;
const TRADING_LIMIT_UNIT = 10n ** BigInt(TRADING_LIMIT_INTERNAL_DECIMALS);
const FRACTION_SCALE = 1_000_000_000n;

// Provenance: mento-core TradingLimitsV2.sol at commit
// 07ecf3df5650a33ea6957f1ad2966e02c5082253. These constants are private
// and compiled into the deployed FPMM, so neither the indexed row nor the
// current FPMM ABI exposes them.
export const FPMM_L0_WINDOW_SECONDS = 300;
export const FPMM_L1_WINDOW_SECONDS = 86_400;

type IntegerValue = bigint | string;

export type StructuralTradingLimit = Pick<
  PegTradingLimitRow,
  | "limit0"
  | "limit1"
  | "netflow0"
  | "netflow1"
  | "lastUpdated0"
  | "lastUpdated1"
>;

export type StructuralWindow = {
  enforced: boolean;
  active: boolean;
  saturationFraction: number | null;
};

export type StructuralSaturation = {
  saturationFraction: number | null;
  controllingWindow: "L0" | "L1" | null;
  windows: {
    l0: StructuralWindow;
    l1: StructuralWindow;
  };
};

function parseInteger(value: IntegerValue, field: string): bigint {
  try {
    return typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new Error(`${field} must be an integer`);
  }
}

function parseTimestamp(value: IntegerValue, field: string): bigint {
  const parsed = parseInteger(value, field);
  if (parsed < 0n) throw new Error(`${field} must be non-negative`);
  return parsed;
}

function ratioToNumber(numerator: bigint, denominator: bigint): number {
  const scaled = (numerator * FRACTION_SCALE) / denominator;
  const result = Number(scaled) / Number(FRACTION_SCALE);
  if (!Number.isFinite(result)) {
    throw new Error("structural saturation is outside the numeric range");
  }
  return result;
}

function computeWindow(input: {
  limitValue: IntegerValue;
  netflowValue: IntegerValue;
  lastUpdatedValue: IntegerValue;
  durationSeconds: number;
  now: bigint;
}): StructuralWindow {
  const limit = parseInteger(input.limitValue, "limit");
  if (limit < 0n) throw new Error("limit must be non-negative");
  const enforced = limit > 0n;
  if (!enforced) {
    return { enforced: false, active: false, saturationFraction: null };
  }

  const lastUpdated = parseTimestamp(input.lastUpdatedValue, "lastUpdated");
  // TradingLimitsV2 resets lazily. Equality remains inside the old window;
  // the indexed netflow expires only once time moves strictly past its end.
  const active = input.now <= lastUpdated + BigInt(input.durationSeconds);
  if (!active) {
    return { enforced: true, active: false, saturationFraction: null };
  }

  // Indexed TradingLimitsV2 netflow is the authoritative numerator. Raw swap
  // events omit the contract's fee-adjusted input, so their reduction below
  // is intentionally advisory and cannot drive this fraction.
  const netflow = parseInteger(input.netflowValue, "netflow");
  const positiveInflow = netflow > 0n ? netflow : 0n;
  return {
    enforced: true,
    active: true,
    saturationFraction: ratioToNumber(positiveInflow, limit),
  };
}

export function computeStructuralSaturation(
  tradingLimit: StructuralTradingLimit,
  nowSeconds: bigint,
): StructuralSaturation {
  const now = parseTimestamp(nowSeconds, "nowSeconds");
  const l0 = computeWindow({
    limitValue: tradingLimit.limit0,
    netflowValue: tradingLimit.netflow0,
    lastUpdatedValue: tradingLimit.lastUpdated0,
    durationSeconds: FPMM_L0_WINDOW_SECONDS,
    now,
  });
  const l1 = computeWindow({
    limitValue: tradingLimit.limit1,
    netflowValue: tradingLimit.netflow1,
    lastUpdatedValue: tradingLimit.lastUpdated1,
    durationSeconds: FPMM_L1_WINDOW_SECONDS,
    now,
  });

  if (l0.saturationFraction === null && l1.saturationFraction === null) {
    return {
      saturationFraction: null,
      controllingWindow: null,
      windows: { l0, l1 },
    };
  }
  if (
    l1.saturationFraction !== null &&
    (l0.saturationFraction === null ||
      l1.saturationFraction > l0.saturationFraction)
  ) {
    return {
      saturationFraction: l1.saturationFraction,
      controllingWindow: "L1",
      windows: { l0, l1 },
    };
  }
  return {
    saturationFraction: l0.saturationFraction,
    controllingWindow: "L0",
    windows: { l0, l1 },
  };
}

function fixed15ToNumber(value: bigint): number {
  const integer = value / TRADING_LIMIT_UNIT;
  const remainder = value % TRADING_LIMIT_UNIT;
  const result =
    Number(integer) + Number(remainder) / Number(TRADING_LIMIT_UNIT);
  if (!Number.isFinite(result)) {
    throw new Error(
      "trading limit is outside the numeric reference-size range",
    );
  }
  return result;
}

export function deriveReferenceSize(
  tradingLimit: Pick<StructuralTradingLimit, "limit0" | "limit1">,
  configuredCap: number,
): number {
  if (!Number.isFinite(configuredCap) || configuredCap <= 0) {
    throw new Error("configured reference-size cap must be positive");
  }

  const limits = [
    parseInteger(tradingLimit.limit0, "limit0"),
    parseInteger(tradingLimit.limit1, "limit1"),
  ];
  if (limits.some((limit) => limit < 0n)) {
    throw new Error("trading limits must be non-negative");
  }
  const enforcedLimits = limits
    .filter((limit) => limit > 0n)
    .map(fixed15ToNumber);
  const referenceSize = Math.min(configuredCap, ...enforcedLimits);
  if (!Number.isFinite(referenceSize) || referenceSize <= 0) {
    throw new Error("derived reference size must be positive");
  }
  return referenceSize;
}

export function normalizeRawAmountTo15Decimals(
  rawAmount: IntegerValue,
  tokenDecimals: number,
): bigint {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0) {
    throw new Error("token decimals must be a non-negative integer");
  }
  const amount = parseInteger(rawAmount, "rawAmount");
  if (amount < 0n) throw new Error("raw swap amount must be non-negative");

  if (tokenDecimals === TRADING_LIMIT_INTERNAL_DECIMALS) return amount;
  if (tokenDecimals < TRADING_LIMIT_INTERNAL_DECIMALS) {
    return (
      amount * 10n ** BigInt(TRADING_LIMIT_INTERNAL_DECIMALS - tokenDecimals)
    );
  }
  return (
    amount / 10n ** BigInt(tokenDecimals - TRADING_LIMIT_INTERNAL_DECIMALS)
  );
}

export type AdvisorySwapSummary = {
  grossInflow15: bigint;
  grossOutflow15: bigint;
  netInflow15: bigint;
  positiveNetInflow15: bigint;
  uniqueCallerCount: number;
};

export function summarizeSwapFlow(
  pool: Pick<
    PegStructuralPoolRow,
    "token0" | "token1" | "token0Decimals" | "token1Decimals"
  >,
  monitoredToken: string,
  swaps: ReadonlyArray<
    Pick<
      PegSwapEventRow,
      "caller" | "amount0In" | "amount1In" | "amount0Out" | "amount1Out"
    >
  >,
): AdvisorySwapSummary {
  const normalizedToken = monitoredToken.toLowerCase();
  const token0Matches = pool.token0?.toLowerCase() === normalizedToken;
  const token1Matches = pool.token1?.toLowerCase() === normalizedToken;
  if (!token0Matches && !token1Matches) {
    throw new Error("monitored token is not part of the indexed pool");
  }

  const callers = new Set<string>();
  let grossInflow15 = 0n;
  let grossOutflow15 = 0n;
  for (const swap of swaps) {
    const decimals = token0Matches ? pool.token0Decimals : pool.token1Decimals;
    const rawIn = token0Matches ? swap.amount0In : swap.amount1In;
    const rawOut = token0Matches ? swap.amount0Out : swap.amount1Out;
    // Normalize each side before reduction. Subtracting raw amounts first is
    // invalid when the pool tokens have different decimal scales.
    grossInflow15 += normalizeRawAmountTo15Decimals(rawIn, decimals);
    grossOutflow15 += normalizeRawAmountTo15Decimals(rawOut, decimals);
    callers.add(swap.caller.toLowerCase());
  }

  const netInflow15 = grossInflow15 - grossOutflow15;
  return {
    grossInflow15,
    grossOutflow15,
    netInflow15,
    positiveNetInflow15: netInflow15 > 0n ? netInflow15 : 0n,
    // Advisory display only. This value never affects paging authority.
    uniqueCallerCount: callers.size,
  };
}
