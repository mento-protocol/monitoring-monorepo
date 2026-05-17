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
  it("uses N/A for untrusted non-finite deviation samples", () => {
    const text = formatOracleChartHoverText({
      snapshot: oracleSnapshot({ hasHealthData: false }),
      price: 1.23456,
      deviation: Number.NaN,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });

    expect(text).toContain("Price: 1.2346 USDC/cUSD");
    expect(text).toContain("Deviation: N/A");
    expect(text).not.toContain("NaN");
  });
});
