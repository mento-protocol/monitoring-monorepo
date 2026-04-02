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

  it("does not punish pre-first-snapshot time", () => {
    // First known state starts 1h into the window and is healthy for 10 min.
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
    expect(formatBinaryHealthPct(0.9912)).toBe("99.1%");
    expect(formatBinaryHealthPct(null)).toBe("N/A");
  });

  it("formats nines", () => {
    expect(formatNines(0.99991)).toBe("4 nines");
    expect(formatNines(0.991)).toBe("2 nines");
    expect(formatNines(0.5)).toBe("0 nines");
  });
});
