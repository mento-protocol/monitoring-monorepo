import { describe, expect, it } from "vitest";
import type { GlobalPoolEntry } from "@/components/global-pools-table/sort";
import { TVL_NETWORK, makeTvlPool } from "@/test-utils/network-fixtures";
import { summarizeProtocolStatus } from "./protocol-status";

const NOW_SECONDS = 1_800_000_000;

function entry(overrides: Parameters<typeof makeTvlPool>[0]): GlobalPoolEntry {
  return {
    network: TVL_NETWORK,
    rates: new Map(),
    pool: makeTvlPool({
      oracleOk: true,
      oracleTimestamp: String(NOW_SECONDS - 60),
      oracleExpiry: "3600",
      priceDifference: "0",
      rebalanceThreshold: 100,
      rebalanceThresholdAbove: 100,
      rebalanceThresholdBelow: 100,
      rebalanceThresholdsKnown: true,
      hasHealthData: true,
      limitStatus: "OK",
      limitPressure0: "0",
      limitPressure1: "0",
      ...overrides,
    }),
  };
}

describe("summarizeProtocolStatus", () => {
  it("counts critical pools, warnings, limit pressure, and rebalance warnings separately", () => {
    const summary = summarizeProtocolStatus({
      failedNetworkCount: 0,
      nowSeconds: NOW_SECONDS,
      entries: [
        entry({
          id: "critical-deviation",
          priceDifference: "300",
          deviationBreachStartedAt: String(NOW_SECONDS - 7200),
        }),
        entry({
          id: "rebalance-watch",
          priceDifference: "120",
          deviationBreachStartedAt: String(NOW_SECONDS - 60),
        }),
        entry({
          id: "limit-warn",
          limitStatus: "WARN",
          limitPressure0: "0.85",
        }),
      ],
    });

    expect(summary.level).toBe("critical");
    expect(summary.criticalCount).toBe(1);
    expect(summary.warnCount).toBe(2);
    expect(summary.rebalanceInFlightCount).toBe(1);
    expect(summary.limitAttentionCount).toBe(1);
    expect(summary.worstDeviation?.poolLabel).toBe("KESm/USDm");
    expect(summary.worstDeviation?.thresholdRatio).toBe(3);
  });

  it("marks failed networks and non-virtual health gaps as attention without inventing critical pools", () => {
    const summary = summarizeProtocolStatus({
      failedNetworkCount: 1,
      nowSeconds: NOW_SECONDS,
      entries: [
        entry({
          id: "gap",
          hasHealthData: false,
        }),
      ],
    });

    expect(summary.level).toBe("warning");
    expect(summary.criticalCount).toBe(0);
    expect(summary.warnCount).toBe(0);
    expect(summary.failedNetworkCount).toBe(1);
    expect(summary.nonVirtualDataGapCount).toBe(1);
  });

  it("stays all clear when loaded pools have no active attention signals", () => {
    const summary = summarizeProtocolStatus({
      failedNetworkCount: 0,
      nowSeconds: NOW_SECONDS,
      entries: [entry({ id: "ok" })],
    });

    expect(summary.level).toBe("ok");
    expect(summary.criticalCount).toBe(0);
    expect(summary.warnCount).toBe(0);
    expect(summary.rebalanceInFlightCount).toBe(0);
    expect(summary.worstDeviation).toBeNull();
  });
});
