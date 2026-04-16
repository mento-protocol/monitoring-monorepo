/**
 * FX market weekend detection.
 *
 * Traditional FX markets are closed from Friday ~21:00 UTC to Sunday ~23:00 UTC.
 * During this window, oracle price data goes stale and pools cannot be traded.
 * This is expected behaviour — NOT a health incident.
 *
 * All weekday/hour constants come from shared-config/fx-calendar.json so the UI
 * and the indexer's healthscore math stay in lockstep.
 */

import FX_CALENDAR from "@mento-protocol/monitoring-config/fx-calendar.json";

const FX_CLOSE_DAY = FX_CALENDAR.fxCloseDay;
export const FX_CLOSE_HOUR_UTC = FX_CALENDAR.fxCloseHourUtc;
const FX_REOPEN_DAY = FX_CALENDAR.fxReopenDay;
export const FX_REOPEN_HOUR_UTC = FX_CALENDAR.fxReopenHourUtc;

/**
 * Returns true if the given time falls within the FX weekend closure window.
 * Window: close day @ close hour UTC (inclusive) → reopen day @ reopen hour UTC
 * (exclusive). Defaults from fx-calendar.json give Fri 21:00 → Sun 23:00.
 */
export function isWeekend(now = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const hour = now.getUTCHours();

  if (day === FX_CLOSE_DAY) return hour >= FX_CLOSE_HOUR_UTC;
  if (day === FX_REOPEN_DAY) return hour < FX_REOPEN_HOUR_UTC;

  // Days strictly between close day and reopen day (mod 7) are fully inside
  // the window. For Fri(5) → Sun(0), that's just Saturday.
  const dayGap = (FX_REOPEN_DAY - FX_CLOSE_DAY + 7) % 7;
  const daysFromClose = (day - FX_CLOSE_DAY + 7) % 7;
  return daysFromClose > 0 && daysFromClose < dayGap;
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

// ---------------------------------------------------------------------------
// Trading-second arithmetic for healthscore math.
//
// Healthscore windows count FX weekend wall-clock time as stale, dragging
// a perfect Mon–Fri week to ~70.7%. Measure durations in trading-seconds
// instead (weekend overlap subtracted) so weekends are excluded from both
// numerator and denominator.
//
// Half-open semantics match isWeekend(): Fri 21:00 UTC inclusive,
// Sun 23:00 UTC exclusive.
// ---------------------------------------------------------------------------

/** Fri 2024-01-05 21:00:00 UTC — anchor for the 7-day weekend cycle. */
export const ANCHOR_FRI_2100 = FX_CALENDAR.anchorFri2100UnixSec;
const WEEK_SECONDS = 7 * 24 * 3600;
/** Derived from all four calendar fields so the weekend arithmetic stays
 * in lockstep with what isWeekend() accepts. For Fri 21:00 → Sun 23:00 this
 * evaluates to 50h (180000s). */
const WEEKEND_DURATION_SECONDS =
  ((FX_REOPEN_DAY - FX_CLOSE_DAY + 7) % 7) * 86400 +
  (FX_REOPEN_HOUR_UTC - FX_CLOSE_HOUR_UTC) * 3600;

/**
 * Seconds in [startTs, endTs) that fall inside FX weekend windows
 * (Fri 21:00 UTC → Sun 23:00 UTC). Closed-form: enumerates weekend windows
 * anchored at ANCHOR_FRI_2100, one iteration per overlapping week.
 */
export function weekendOverlapSeconds(startTs: number, endTs: number): number {
  if (endTs <= startTs) return 0;
  let total = 0;
  // Floor toward -∞ so weekends before the anchor are enumerated too.
  const offset = startTs - ANCHOR_FRI_2100;
  let k = Math.floor(offset / WEEK_SECONDS);
  while (true) {
    const wStart = ANCHOR_FRI_2100 + k * WEEK_SECONDS;
    const wEnd = wStart + WEEKEND_DURATION_SECONDS;
    if (wStart >= endTs) break;
    if (wEnd > startTs) {
      total += Math.min(wEnd, endTs) - Math.max(wStart, startTs);
    }
    k += 1;
  }
  return total;
}

/**
 * Seconds in [startTs, endTs) that fall outside FX weekend windows —
 * i.e. "trading-seconds". Used by healthscore math so weekend gaps don't
 * count against the score.
 */
export function tradingSecondsInRange(startTs: number, endTs: number): number {
  if (endTs <= startTs) return 0;
  return endTs - startTs - weekendOverlapSeconds(startTs, endTs);
}
