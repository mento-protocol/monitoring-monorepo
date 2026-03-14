import { describe, expect, it } from "vitest";
import { isWeekend, FX_CLOSE_HOUR_UTC, FX_REOPEN_HOUR_UTC } from "../weekend";

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
