import { describe, expect, it } from "vitest";
import { getDebtTokenSideLabel } from "../page";
import type { Pool } from "@/lib/types";

function makePool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "0xpool",
    source: "fpmm_factory",
    token0: "0x0000000000000000000000000000000000000001",
    token1: "0x0000000000000000000000000000000000000002",
    token0Decimals: 18,
    token1Decimals: 18,
    reserves0: "0",
    reserves1: "0",
    oraclePrice: "0",
    oracleOk: false,
    oracleTimestamp: "0",
    oracleNumReporters: 0,
    oracleExpiry: "0",
    oracleTxHash: "",
    referenceRateFeedID: "",
    priceDifference: "0",
    rebalanceThreshold: 0,
    healthStatus: "healthy",
    limitStatus: "ok",
    limitPressure0: "normal",
    limitPressure1: "normal",
    swapCount: 0,
    rebalanceCount: 0,
    notionalVolume0: "0",
    notionalVolume1: "0",
    createdAtBlock: "0",
    createdAtTimestamp: "0",
    updatedAtBlock: "0",
    updatedAtTimestamp: "0",
    ...overrides,
  };
}

describe("getDebtTokenSideLabel", () => {
  it("returns token0 when debt token matches token0", () => {
    expect(
      getDebtTokenSideLabel(
        makePool(),
        "0x0000000000000000000000000000000000000001",
      ),
    ).toBe("token0");
  });

  it("returns token1 when debt token matches token1", () => {
    expect(
      getDebtTokenSideLabel(
        makePool(),
        "0x0000000000000000000000000000000000000002",
      ),
    ).toBe("token1");
  });

  it("returns unknown when pool metadata is missing", () => {
    expect(
      getDebtTokenSideLabel(makePool({ token0: null, token1: null }), "0x123"),
    ).toBe("unknown");
  });

  it("returns unknown when debt token does not match either pool token", () => {
    expect(
      getDebtTokenSideLabel(
        makePool(),
        "0x0000000000000000000000000000000000000003",
      ),
    ).toBe("unknown");
  });
});
