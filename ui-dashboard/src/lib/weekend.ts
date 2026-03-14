/**
 * FX market weekend detection.
 *
 * Traditional FX markets are closed from Friday ~21:00 UTC to Sunday ~23:00 UTC.
 * During this window, oracle price data goes stale and pools cannot be traded.
 * This is expected behaviour — NOT a health incident.
 */

/** UTC hour on Friday when FX markets close (approx). */
export const FX_CLOSE_DAY = 5; // Friday (0=Sun, 5=Fri, 6=Sat)
export const FX_CLOSE_HOUR_UTC = 21;

/** UTC hour on Sunday when FX markets reopen (approx). */
export const FX_REOPEN_DAY = 0; // Sunday
export const FX_REOPEN_HOUR_UTC = 23;

/**
 * Returns true if the given time falls within the FX weekend closure window.
 * Window: Friday 21:00 UTC → Sunday 23:00 UTC
 */
export function isWeekend(now = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const hour = now.getUTCHours();

  // Saturday is always in the window
  if (day === 6) return true;

  // Friday from FX_CLOSE_HOUR_UTC onward
  if (day === FX_CLOSE_DAY && hour >= FX_CLOSE_HOUR_UTC) return true;

  // Sunday before FX_REOPEN_HOUR_UTC
  if (day === FX_REOPEN_DAY && hour < FX_REOPEN_HOUR_UTC) return true;

  return false;
}

/**
 * Returns true when the pool's oracle is stale AND we are currently
 * in the FX weekend closure window — i.e. the staleness is expected.
 *
 * Note: takes an explicit `isOracleFreshFn` parameter to avoid circular imports
 * (health.ts → weekend.ts). Callers should pass `isOracleFresh` from health.ts.
 */
export function isWeekendOracleStale(
  pool: { oracleTimestamp?: string; oracleExpiry?: string },
  isOracleFreshFn: (
    pool: { oracleTimestamp?: string; oracleExpiry?: string },
    nowSeconds?: number,
    chainId?: number,
  ) => boolean,
  chainId?: number,
  now?: Date,
): boolean {
  if (!isWeekend(now)) return false;
  const nowSeconds = now
    ? Math.floor(now.getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  return !isOracleFreshFn(pool, nowSeconds, chainId);
}
