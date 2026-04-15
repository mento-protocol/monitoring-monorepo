import { describe, expect, it } from "vitest";
import {
  computeBinaryHealthWindow,
  formatBinaryHealthPct,
  formatNines,
  normalizeWindowSnapshots,
} from "@/lib/pool-health-score";
import type { OracleSnapshot, Pool } from "@/lib/types";

function snap(
  timestamp: number,
  deviationRatio: string,
  healthBinaryValue: string,
): OracleSnapshot {
  return {
    id: `s-${timestamp}`,
    chainId: 42220,
    poolId: "42220-0xpool",
    timestamp: String(timestamp),
    oraclePrice: "1",
    oracleOk: true,
    numReporters: 1,
    priceDifference: "0",
    rebalanceThreshold: 5000,
    source: "oracle_reported",
    blockNumber: String(timestamp),
    txHash: `0x${timestamp}`,
    deviationRatio,
    healthBinaryValue,
    hasHealthData: true,
  };
}

const pool: Pick<Pool, "oracleExpiry"> = { oracleExpiry: "300" };

describe("computeBinaryHealthWindow", () => {
  it("returns null when no snapshots exist", () => {
    const result = computeBinaryHealthWindow([], pool, 0, 3600);
    expect(result.score).toBeNull();
    expect(result.trackedSeconds).toBe(0);
  });

  it("excludes pre-first-snapshot time from denominator (new pools not punished)", () => {
    // First known state starts 1h into the 2h window.
    // Denominator begins at first snapshot (t=3600), not at windowStart (t=0).
    // After the snapshot, freshnessLimit=300s counts as healthy, rest as stale.
    const result = computeBinaryHealthWindow(
      [snap(3600, "0.500000", "1.000000")],
      pool,
      0,
      7200,
    );
    // Only tracked from first snapshot onward: 3600s total
    // freshness carry = 300s healthy, stale = 3300s unhealthy
    expect(result.trackedSeconds).toBe(3600);
    expect(result.healthySeconds).toBe(300);
    expect(result.score).toBeCloseTo(300 / 3600);
  });

  it("counts healthy carried time and stale unhealthy time", () => {
    const result = computeBinaryHealthWindow(
      [snap(0, "0.500000", "1.000000"), snap(600, "0.500000", "1.000000")],
      pool,
      0,
      600,
    );
    // first segment 0..600: carry 300 healthy, stale 300 unhealthy
    expect(result.trackedSeconds).toBe(600);
    expect(result.healthySeconds).toBe(300);
    expect(result.staleSeconds).toBe(300);
    expect(result.score).toBe(0.5);
  });

  it("gives 0 healthy seconds for unhealthy intervals", () => {
    const result = computeBinaryHealthWindow(
      [snap(0, "1.500000", "0.000000"), snap(600, "1.500000", "0.000000")],
      pool,
      0,
      600,
    );
    expect(result.trackedSeconds).toBe(600);
    expect(result.healthySeconds).toBe(0);
    expect(result.score).toBe(0);
  });

  it("uses predecessor snapshot to cover the left window boundary", () => {
    const result = computeBinaryHealthWindow(
      [snap(900, "0.500000", "1.000000"), snap(1500, "0.500000", "1.000000")],
      pool,
      1000,
      1600,
    );
    // predecessor at 900 carries into the window starting at 1000
    // segment 1000..1500 => 500s duration => 200s carry (to freshness end 1200), 300 stale
    // segment 1500..1600 => 100s duration => 100s carry healthy
    expect(result.trackedSeconds).toBe(600);
    expect(result.healthySeconds).toBe(300);
    expect(result.score).toBe(0.5);
  });

  it("excludes hasHealthData=false snapshots from tracked time", () => {
    const noDataSnap: OracleSnapshot = {
      ...snap(0, "0.000000", "1.000000"),
      hasHealthData: false,
    };
    const result = computeBinaryHealthWindow(
      [noDataSnap, snap(300, "0.500000", "1.000000")],
      pool,
      0,
      600,
    );
    // First segment (0..300) should be skipped entirely (no-data)
    // Second segment (300..600) = 300s, carry 300s healthy
    expect(result.trackedSeconds).toBe(300);
    expect(result.healthySeconds).toBe(300);
    expect(result.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Weekend exclusion
// ---------------------------------------------------------------------------

/** Seconds of a fixed UTC moment. 2026-03-09 is a Monday. */
function ts(day: number, hour: number, minute = 0): number {
  // day: 0=Sun(after Sat), 1=Mon, ..., 5=Fri, 6=Sat — see weekend.test.ts
  const base = new Date("2026-03-09T00:00:00Z");
  const offset = (day - 1 + 7) % 7;
  const d = new Date(base);
  d.setUTCDate(base.getUTCDate() + offset);
  d.setUTCHours(hour, minute, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

describe("computeBinaryHealthWindow (weekend-aware)", () => {
  const oneHourExpiry: Pick<Pool, "oracleExpiry"> = { oracleExpiry: "3600" };

  it("counts only trading-seconds when a segment straddles Friday close", () => {
    // Snapshot at Fri 20:30, window ends Sat 02:00. Only Fri 20:30→21:00
    // (30 min) counts as trading; freshness carry 1h (20:30→21:30) is
    // 30 min trading. Score = 1.0, tracked = 1800.
    const snapTs = ts(5, 20, 30);
    const windowEnd = ts(6, 2); // Sat 02:00
    const result = computeBinaryHealthWindow(
      [snap(snapTs, "0.500000", "1.000000")],
      oneHourExpiry,
      snapTs,
      windowEnd,
    );
    expect(result.trackedSeconds).toBe(1800);
    expect(result.healthySeconds).toBe(1800);
    expect(result.staleSeconds).toBe(0);
    expect(result.score).toBe(1);
  });

  it("returns null score for a weekend-only window", () => {
    const snapTs = ts(6, 0); // Sat 00:00
    const windowEnd = ts(0, 22); // Sun 22:00 (same weekend)
    const result = computeBinaryHealthWindow(
      [snap(snapTs, "0.500000", "1.000000")],
      oneHourExpiry,
      snapTs,
      windowEnd,
    );
    expect(result.trackedSeconds).toBe(0);
    expect(result.score).toBeNull();
  });

  it("excludes the weekend from a Fri→Mon gap (stale weekday tail only)", () => {
    // Healthy snap at Fri 20:00, window ends Mon 03:00. No new snapshots.
    // trading-seconds: 1h Fri (20:00→21:00) + 4h Mon (Sun 23:00 → Mon 03:00)
    //   = 5h = 18000s tracked
    // carry: Fri 20:00→21:00 = 1h trading = 3600s healthy (healthy snap)
    // stale: 18000 - 3600 = 14400s (post-freshness on Monday morning)
    const snapTs = ts(5, 20);
    const windowEnd = ts(1, 3) + 7 * 86400; // Mon 03:00 NEXT week
    const result = computeBinaryHealthWindow(
      [snap(snapTs, "0.500000", "1.000000")],
      oneHourExpiry,
      snapTs,
      windowEnd,
    );
    expect(result.trackedSeconds).toBe(18000);
    expect(result.healthySeconds).toBe(3600);
    expect(result.staleSeconds).toBe(14400);
    expect(result.score).toBeCloseTo(3600 / 18000);
  });

  it("scores a perfect Mon-Fri trading week at 100% even when window extends past Fri close", () => {
    // Window covers a FULL week (168h wall-clock) with snapshots every 5 min
    // Mon 00:00 → Fri 20:55 only. Weekend (Fri 21:00 → Sun 23:00) is unsampled
    // and must not drag the score down. Post-weekend Sun 23:00 → Mon 00:00 (1h)
    // has no snapshot and will count as stale — acceptable edge since the fix
    // concerns the weekend itself.
    const windowStart = ts(1, 0); // Mon 00:00
    const windowEnd = windowStart + 7 * 86400; // Mon 00:00 next week
    const lastSnapTs = ts(5, 20, 55); // Fri 20:55
    const snapshots: OracleSnapshot[] = [];
    for (let t = windowStart; t <= lastSnapTs; t += 300) {
      snapshots.push(snap(t, "0.500000", "1.000000"));
    }
    const result = computeBinaryHealthWindow(
      snapshots,
      { oracleExpiry: "300" },
      windowStart,
      windowEnd,
    );
    // Weekday coverage Mon 00:00 → Fri 20:55: 1404 snapshots at 300s stride,
    // producing 1403 full 5-min segments (each fully within freshness) plus a
    // final open-ended segment from Fri 20:55 to windowEnd.
    // 1403 * 300 = 117h - 5min = 420900s of segments fully carried + final
    // segment Fri 20:55 → windowEnd measured in trading seconds.
    // Trading seconds in [Fri 20:55, Mon 00:00) = 5min (Fri 20:55→21:00) + 1h
    // (Sun 23:00→Mon 00:00) = 3900s. Carry 300s of that, stale 3600s.
    // tracked = (117h - 5min) + 3900s = 420900 + 3900 = 424800s.
    // healthy = (117h - 5min) + 300s = 420900 + 300 = 421200s.
    expect(result.trackedSeconds).toBe(117 * 3600 - 300 + 3900);
    expect(result.healthySeconds).toBe(117 * 3600 - 300 + 300);
    // Score = 421200 / 424800 ≈ 99.15%, which is dramatically better than
    // the pre-fix ~70% the PR was written to address.
    expect(result.score).toBeGreaterThan(0.99);
    // Regression guard: the pre-fix wall-clock formula would have given
    // tracked = 117h + 3 days 3h 5min = 168h and dragged the score to ~70%.
    expect(result.trackedSeconds).toBeLessThan(120 * 3600); // NOT 168h
    // Regression guard on denominator composition: proves the weekend was
    // excluded from tracked seconds (otherwise tracked would balloon to 168h).
    expect(result.healthySeconds).toBeGreaterThan(117 * 3600 - 300);
  });

  it("matches pre-weekend-change math for weekday-only windows", () => {
    // Regression: a Tue→Wed window behaves identically to the old
    // wall-clock formula (sanity check that the trading-seconds helper is
    // a no-op on weekdays).
    const windowStart = ts(2, 12); // Tue 12:00
    const result = computeBinaryHealthWindow(
      [
        snap(windowStart, "0.500000", "1.000000"),
        snap(windowStart + 600, "0.500000", "1.000000"),
      ],
      pool, // oracleExpiry=300
      windowStart,
      windowStart + 600,
    );
    expect(result.trackedSeconds).toBe(600);
    expect(result.healthySeconds).toBe(300);
    expect(result.staleSeconds).toBe(300);
    expect(result.score).toBe(0.5);
  });
});

describe("normalizeWindowSnapshots", () => {
  it("does not mark exact-limit results as truncated", () => {
    const raw = Array.from({ length: 1000 }, (_, i) =>
      snap(i + 1, "0.500000", "1.000000"),
    ).reverse();

    const result = normalizeWindowSnapshots(raw, 1000);

    expect(result.truncated).toBe(false);
    expect(result.snapshotsAsc).toHaveLength(1000);
    expect(result.snapshotsAsc[0]?.timestamp).toBe("1");
    expect(result.snapshotsAsc[999]?.timestamp).toBe("1000");
  });

  it("marks over-limit results as truncated and drops only the oldest extra row", () => {
    const raw = Array.from({ length: 1001 }, (_, i) =>
      snap(i + 1, "0.500000", "1.000000"),
    ).reverse();

    const result = normalizeWindowSnapshots(raw, 1000);

    expect(result.truncated).toBe(true);
    expect(result.snapshotsAsc).toHaveLength(1000);
    expect(result.snapshotsAsc[0]?.timestamp).toBe("2");
    expect(result.snapshotsAsc[999]?.timestamp).toBe("1001");
  });
});

describe("format helpers", () => {
  it("formats percentages", () => {
    expect(formatBinaryHealthPct(0.9912)).toBe("99.12%");
    expect(formatBinaryHealthPct(null)).toBe("N/A");
  });

  it("formats nines", () => {
    expect(formatNines(0.99991)).toBe("4 nines");
    expect(formatNines(0.991)).toBe("2 nines");
    expect(formatNines(0.5)).toBe("0 nines");
  });
});
