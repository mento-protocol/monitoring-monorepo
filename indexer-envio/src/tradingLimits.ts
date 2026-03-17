// ---------------------------------------------------------------------------
// Trading limit types and computation
// ---------------------------------------------------------------------------

/** TradingLimitsV2 stores all limit/netflow values in 15-decimal internal precision. */
export const TRADING_LIMITS_INTERNAL_DECIMALS = 15;

export type TradingLimitData = {
  config: { limit0: bigint; limit1: bigint; decimals: number };
  state: {
    lastUpdated0: number;
    lastUpdated1: number;
    netflow0: bigint;
    netflow1: bigint;
  };
};

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
