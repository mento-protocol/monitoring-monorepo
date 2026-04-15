import { describe, expect, it } from "vitest";
import {
  isWeekend,
  FX_CLOSE_HOUR_UTC,
  FX_REOPEN_HOUR_UTC,
  ANCHOR_FRI_2100,
  tradingSecondsInRange,
  weekendOverlapSeconds,
} from "../weekend";

/** Seconds from a UTC date built via `utc()`. */
function sec(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** Helper: create a UTC date */
function utc(day: number, hour: number, minute = 0): Date {
  // day: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  // Find a date where getUTCDay() === day
  const base = new Date("2026-03-09T00:00:00Z"); // Monday 2026-03-09
  const offset = (day - 1 + 7) % 7; // days from Monday
  const d = new Date(base);
  d.setUTCDate(base.getUTCDate() + offset);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

describe("isWeekend", () => {
  it("returns false on Monday", () => {
    expect(isWeekend(utc(1, 12))).toBe(false);
  });

  it("returns false on Friday before market close", () => {
    expect(isWeekend(utc(5, FX_CLOSE_HOUR_UTC - 1))).toBe(false);
  });

  it("returns true on Friday at market close hour", () => {
    expect(isWeekend(utc(5, FX_CLOSE_HOUR_UTC))).toBe(true);
  });

  it("returns true on Friday after market close", () => {
    expect(isWeekend(utc(5, 23))).toBe(true);
  });

  it("returns true all day Saturday", () => {
    expect(isWeekend(utc(6, 0))).toBe(true);
    expect(isWeekend(utc(6, 12))).toBe(true);
    expect(isWeekend(utc(6, 23))).toBe(true);
  });

  it("returns true on Sunday before market reopen", () => {
    expect(isWeekend(utc(0, 0))).toBe(true);
    expect(isWeekend(utc(0, FX_REOPEN_HOUR_UTC - 1))).toBe(true);
  });

  it("returns false on Sunday at market reopen hour", () => {
    expect(isWeekend(utc(0, FX_REOPEN_HOUR_UTC))).toBe(false);
  });

  it("returns false on Sunday after market reopen", () => {
    expect(isWeekend(utc(0, FX_REOPEN_HOUR_UTC + 1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWeekendOracleStale
// ---------------------------------------------------------------------------
import { isWeekendOracleStale } from "../weekend";
import { isOracleFresh } from "../health";

// Fixed "now" for deterministic tests — Saturday noon UTC
const SAT_NOON = new Date("2026-03-14T12:00:00Z"); // Saturday
const MON_NOON = new Date("2026-03-16T12:00:00Z"); // Monday

const FRESH_TS = String(Math.floor(SAT_NOON.getTime() / 1000) - 60); // 60s ago
const STALE_TS = String(Math.floor(SAT_NOON.getTime() / 1000) - 600); // 600s ago (> 300s)

describe("isWeekendOracleStale", () => {
  it("returns true when oracle is stale AND it is the weekend", () => {
    expect(
      isWeekendOracleStale(
        { oracleTimestamp: STALE_TS, oracleExpiry: "300" },
        isOracleFresh,
        undefined,
        SAT_NOON,
      ),
    ).toBe(true);
  });

  it("returns false when oracle is fresh (even on the weekend)", () => {
    expect(
      isWeekendOracleStale(
        { oracleTimestamp: FRESH_TS, oracleExpiry: "300" },
        isOracleFresh,
        undefined,
        SAT_NOON,
      ),
    ).toBe(false);
  });

  it("returns false when oracle is stale but it is a weekday", () => {
    expect(
      isWeekendOracleStale(
        { oracleTimestamp: STALE_TS, oracleExpiry: "300" },
        isOracleFresh,
        undefined,
        MON_NOON,
      ),
    ).toBe(false);
  });

  it("respects chainId for staleness threshold (Monad 360s)", () => {
    // 340s old — stale at 300s default but fresh at Monad's 360s
    const sat = SAT_NOON;
    const ts340 = String(Math.floor(sat.getTime() / 1000) - 340);
    expect(
      isWeekendOracleStale(
        { oracleTimestamp: ts340, oracleExpiry: "0" },
        isOracleFresh,
        143, // Monad mainnet
        sat,
      ),
    ).toBe(false); // fresh at 360s threshold → NOT weekend-stale
  });
});

// ---------------------------------------------------------------------------
// tradingSecondsInRange / weekendOverlapSeconds
// ---------------------------------------------------------------------------

describe("ANCHOR_FRI_2100", () => {
  // Guard: if the FX close/reopen constants change, the anchor must be
  // re-derived. This catches that mistake.
  it("is a Friday 21:00 UTC", () => {
    const d = new Date(ANCHOR_FRI_2100 * 1000);
    expect(d.getUTCDay()).toBe(5);
    expect(d.getUTCHours()).toBe(FX_CLOSE_HOUR_UTC);
    expect(d.getUTCMinutes()).toBe(0);
  });
});

describe("tradingSecondsInRange", () => {
  it("returns 0 when end <= start", () => {
    expect(tradingSecondsInRange(100, 100)).toBe(0);
    expect(tradingSecondsInRange(200, 100)).toBe(0);
  });

  it("returns full duration for a weekday-only range", () => {
    // Mon 12:00 → Tue 12:00
    const start = sec(utc(1, 12));
    const end = sec(utc(2, 12));
    expect(tradingSecondsInRange(start, end)).toBe(86400);
  });

  it("returns 0 for a weekend-only range", () => {
    // Sat 2026-03-14 00:00 → Sun 2026-03-15 22:00 (both inside weekend window)
    const start = sec(utc(6, 0));
    const end = sec(utc(0, 22));
    expect(end).toBeGreaterThan(start); // utc(0) is Sunday AFTER Saturday
    expect(tradingSecondsInRange(start, end)).toBe(0);
  });

  it("counts only pre-close seconds when straddling Friday close", () => {
    // Fri 20:30 → Sat 00:30 = 4h range; only Fri 20:30..21:00 is trading
    const start = sec(utc(5, 20, 30));
    const end = start + 4 * 3600;
    expect(tradingSecondsInRange(start, end)).toBe(1800);
  });

  it("counts only post-reopen seconds when straddling Sunday reopen", () => {
    // Sun 22:30 → Mon 00:30 = 2h range; only Sun 23:00..Mon 00:30 is trading
    const sunStart = sec(utc(0, 22, 30));
    // utc(0,...) is the Sunday BEFORE Monday 2026-03-09 base — fine, it's
    // a real Sunday 22:30 UTC; we only need relative arithmetic.
    const end = sunStart + 2 * 3600;
    expect(tradingSecondsInRange(sunStart, end)).toBe(5400); // 90 min
  });

  it("subtracts one weekend for a Mon→Mon range", () => {
    const start = sec(utc(1, 0)); // Mon 00:00
    const end = start + 7 * 86400; // Mon 00:00 next week
    // Full week = 604800s, one weekend = 50h = 180000s
    expect(tradingSecondsInRange(start, end)).toBe(604800 - 180000);
  });

  it("subtracts two weekends for a two-week range", () => {
    const start = sec(utc(1, 0));
    const end = start + 14 * 86400;
    expect(tradingSecondsInRange(start, end)).toBe(14 * 86400 - 2 * 180000);
  });

  it("handles ranges before the anchor epoch", () => {
    // ANCHOR_FRI_2100 = 2024-01-05 21:00 UTC. Use a range in 2020.
    const before = Math.floor(
      new Date("2020-06-01T00:00:00Z").getTime() / 1000,
    );
    const after = before + 7 * 86400; // Mon 2020-06-01 → Mon 2020-06-08
    expect(tradingSecondsInRange(before, after)).toBe(604800 - 180000);
  });
});

describe("weekendOverlapSeconds", () => {
  it("returns 0 for a weekday-only range", () => {
    const start = sec(utc(1, 12));
    const end = sec(utc(2, 12));
    expect(weekendOverlapSeconds(start, end)).toBe(0);
  });

  it("returns the full weekend for a range fully covering it", () => {
    // Thu 00:00 → Tue 00:00 (5 days) — contains exactly one weekend
    const start = sec(utc(4, 0)); // Thursday
    const end = start + 5 * 86400;
    expect(weekendOverlapSeconds(start, end)).toBe(180000);
  });
});
