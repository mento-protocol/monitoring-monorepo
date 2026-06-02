// Mirrors ui-dashboard/src/lib/tokens.ts and alerts/rules/main.tf's
// `usd_pegged_symbols_regex_part`. The drift-protection test in
// test/deviation-alert-state.test.ts enforces this until the FX classifier
// moves into shared-config.
export const USD_PEGGED_SYMBOLS: ReadonlySet<string> = new Set([
  "USDm",
  "USDC",
  "USDT",
  "USDT0",
  "USD₮",
  "AUSD",
  "cUSD",
  "axlUSDC",
]);

export type FxMarketPauseReason = "fx_weekend_closed" | "fx_reopen_grace";

export function isFxPair(pair: string): boolean {
  const [token0, token1, extra] = pair.split("/");
  if (!token0 || !token1 || extra) return false;
  return !(USD_PEGGED_SYMBOLS.has(token0) && USD_PEGGED_SYMBOLS.has(token1));
}

export function isFxWeekend(nowSeconds: number): boolean {
  const date = new Date(nowSeconds * 1000);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return day === 6 || (day === 0 && hour < 23) || (day === 5 && hour >= 21);
}

export function isFxReopenGrace(nowSeconds: number): boolean {
  const date = new Date(nowSeconds * 1000);
  return date.getUTCDay() === 0 && date.getUTCHours() === 23;
}

export function classifyFxMarketPause(
  pair: string,
  nowSeconds: number,
): FxMarketPauseReason | null {
  if (!isFxPair(pair)) return null;
  if (isFxWeekend(nowSeconds)) return "fx_weekend_closed";
  if (isFxReopenGrace(nowSeconds)) return "fx_reopen_grace";
  return null;
}
