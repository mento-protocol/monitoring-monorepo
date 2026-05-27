import { describe, expect, it } from "vitest";
import { formatOracleChartHoverText } from "../oracle-chart";
import type { OracleSnapshot } from "@/lib/types";

function oracleSnapshot(
  overrides: Partial<OracleSnapshot> = {},
): OracleSnapshot {
  return {
    id: "snapshot-1",
    chainId: 42220,
    poolId: "42220-0xpool",
    timestamp: "1778457600",
    oraclePrice: "1000000000000000000",
    oracleOk: true,
    numReporters: 3,
    priceDifference: "0",
    rebalanceThreshold: 500,
    source: "SortedOracles",
    blockNumber: "1",
    txHash: "0xabc",
    hasHealthData: true,
    ...overrides,
  };
}

describe("formatOracleChartHoverText", () => {
  it("renders price + breaker verdict when inside the band", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 1.0005,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });

    expect(text).toContain("Oracle feed: 1.00050000 (raw cUSD/USDC pair)");
    expect(text).toContain("+5.0 bps");
    expect(text).toContain("within current band");
  });

  it("flags breaker trip when delta exceeds threshold", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 0.998,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      token0Symbol: "USDm",
      token1Symbol: "USDT",
    });

    expect(text).toContain("-20.0 bps");
    expect(text).toContain("would trip current band");
  });

  it("renders N/A safely when price is not finite", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: Number.NaN,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });

    expect(text).toContain("Oracle feed: N/A");
    expect(text).not.toContain("NaN");
  });

  it("omits delta line when baseline is unknown", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 1.0,
      baseline: null,
      thresholdRatio: null,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });

    expect(text).not.toContain("Δ vs baseline");
  });
});
