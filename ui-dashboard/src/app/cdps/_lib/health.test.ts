import { describe, expect, it } from "vitest";
import {
  aggregateTroves,
  aggregatesForCollateral,
  deriveCdpHealth,
  type CdpAggregates,
} from "./health";
import type { CdpCollateral, CdpInstance, CdpTrove } from "./types";

const collateral = (overrides: Partial<CdpCollateral> = {}): CdpCollateral => ({
  id: "42220-test",
  chainId: 42220,
  collIndex: 0,
  symbol: "GBPm",
  debtToken: "0x0",
  collToken: "0x0",
  troveManager: "0x0",
  stabilityPool: "0x0",
  minDebt: "1000000000000000000000",
  minBoldInSp: "1000000000000000000",
  systemParamsLoaded: true,
  mcrBps: 11000,
  ccrBps: 13500,
  scrBps: 11000,
  ...overrides,
});

const instance = (overrides: Partial<CdpInstance> = {}): CdpInstance => ({
  id: "42220-test",
  collateralId: "42220-test",
  chainId: 42220,
  systemColl: "0",
  systemDebt: "0",
  tcrBps: -1,
  spDeposits: "0",
  spColl: "0",
  spHeadroom: "-1",
  currentRedemptionRateBps: 0,
  activeTroveCount: 0,
  icrP1Bps: -1,
  icrP5Bps: -1,
  icrP50Bps: -1,
  icrFracBelowMcrBps: -1,
  liqCountCum: 0,
  redemptionCountCum: 0,
  borrowingFeeCum: "0",
  redemptionFeeCum: "0",
  isShutDown: false,
  shutDownAt: null,
  shutDownTcrBps: null,
  lastEventBlock: "0",
  lastEventTimestamp: "0",
  ...overrides,
});

const trove = (status: string, debt: string, coll = "0"): CdpTrove => ({
  id: `${status}-${debt}`,
  troveId: "0x1",
  owner: "0x0",
  status,
  debt,
  coll,
  icrBps: -1,
  interestRate: "0",
  interestBatchId: null,
  lastUpdatedAt: "0",
  redemptionCount: 0,
  redeemedDebt: "0",
  redeemedColl: "0",
});

describe("aggregateTroves", () => {
  it("sums debt+coll across active and zombie, skipping closed/liquidated/redeemed", () => {
    const result = aggregateTroves([
      trove("active", "1000000000000000000000", "2000000000000000000000"),
      trove("zombie", "500000000000000000000", "1500000000000000000000"),
      trove("closed", "0"),
      trove("liquidated", "999"),
      trove("redeemed", "0", "9999"),
    ]);
    expect(result.openTroveCount).toBe(2);
    expect(result.totalDebt).toBe(BigInt("1500000000000000000000"));
    expect(result.totalColl).toBe(BigInt("3500000000000000000000"));
  });

  it("returns zeros for empty input", () => {
    expect(aggregateTroves([])).toEqual({
      openTroveCount: 0,
      totalDebt: BigInt(0),
      totalColl: BigInt(0),
      truncated: false,
    });
  });

  it("propagates truncated flag from options", () => {
    const result = aggregateTroves(
      [trove("active", "1000000000000000000000")],
      { truncated: true },
    );
    expect(result.truncated).toBe(true);
  });
});

describe("aggregatesForCollateral (list-page lookup)", () => {
  const fullAgg: CdpAggregates = {
    openTroveCount: 3,
    totalDebt: BigInt("3000000000000000000000"),
    totalColl: BigInt("6000000000000000000000"),
    truncated: false,
  };

  it("returns the per-collateral aggregate when present", () => {
    const map = new Map([["42220-A", fullAgg]]);
    expect(aggregatesForCollateral("42220-A", map, false)).toBe(fullAgg);
  });

  it("returns plain EMPTY_AGGREGATES when collateral missing and query not truncated", () => {
    const result = aggregatesForCollateral("42220-Missing", new Map(), false);
    expect(result.openTroveCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("propagates truncated=true when collateral missing and query hit the cap", () => {
    // Regression guard for the chain-wide cap path: when the trove query is
    // capped, a collateral whose troves got sorted past the cutoff has no
    // map entry and would otherwise fall back to plain EMPTY_AGGREGATES,
    // rendering as Healthy / no-debt.
    const map = new Map([["42220-A", fullAgg]]);
    const result = aggregatesForCollateral("42220-Missing", map, true);
    expect(result.openTroveCount).toBe(0);
    expect(result.totalDebt).toBe(BigInt(0));
    expect(result.truncated).toBe(true);
  });
});

describe("deriveCdpHealth", () => {
  const aggWithDebt = (debt: bigint) => ({
    openTroveCount: 1,
    totalDebt: debt,
    totalColl: BigInt(0),
    truncated: false,
  });
  const emptyAgg = {
    openTroveCount: 0,
    totalDebt: BigInt(0),
    totalColl: BigInt(0),
    truncated: false,
  };

  it("shutdown takes precedence over everything", () => {
    const h = deriveCdpHealth(
      collateral(),
      instance({ isShutDown: true, spDeposits: "999999999999999999999999" }),
      aggWithDebt(BigInt(1000)),
    );
    expect(h.state).toBe("shutdown");
  });

  it("notes unloaded system params in reasons but does not force unknown", () => {
    const h = deriveCdpHealth(
      collateral({ systemParamsLoaded: false }),
      instance(),
      emptyAgg,
    );
    // SP-empty + no debt is healthy; the params-not-loaded note is added
    // to reasons so operators see why some ratio checks are missing.
    expect(h.state).toBe("healthy");
    expect(h.reasons).toContain("System params not yet loaded");
  });

  it("SP-empty + debt is critical even when system params are not loaded", () => {
    // Real GBPm production case (2026-05-19): systemParamsLoaded=false,
    // 314k debt across 4 troves, SP totally empty.
    const h = deriveCdpHealth(
      collateral({ systemParamsLoaded: false }),
      instance({ spDeposits: "0" }),
      aggWithDebt(BigInt("314000000000000000000000")),
    );
    expect(h.state).toBe("critical");
    expect(h.reasons).toContain("System params not yet loaded");
  });

  it("returns unknown when instance is missing", () => {
    const h = deriveCdpHealth(collateral(), undefined, emptyAgg);
    expect(h.state).toBe("unknown");
  });

  it("critical when SP is empty and there is outstanding debt", () => {
    const h = deriveCdpHealth(
      collateral(),
      instance({ spDeposits: "0" }),
      aggWithDebt(BigInt("1000000000000000000000")),
    );
    expect(h.state).toBe("critical");
    expect(h.reasons[0]).toMatch(/Stability Pool is empty/i);
  });

  it("critical when SP covers under 5% of debt", () => {
    // 49 / 1000 = 4.9% → critical
    const h = deriveCdpHealth(
      collateral(),
      instance({ spDeposits: "49000000000000000000" }),
      aggWithDebt(BigInt("1000000000000000000000")),
    );
    expect(h.state).toBe("critical");
  });

  it("warning when SP covers 5-50% of debt", () => {
    // 200 / 1000 = 20% → warning
    const h = deriveCdpHealth(
      collateral(),
      instance({ spDeposits: "200000000000000000000" }),
      aggWithDebt(BigInt("1000000000000000000000")),
    );
    expect(h.state).toBe("warning");
  });

  it("healthy when SP covers 50%+ of debt", () => {
    // 800 / 1000 = 80% → healthy
    const h = deriveCdpHealth(
      collateral(),
      instance({ spDeposits: "800000000000000000000" }),
      aggWithDebt(BigInt("1000000000000000000000")),
    );
    expect(h.state).toBe("healthy");
  });

  it("healthy (no-debt informational reason) when system has no troves", () => {
    const h = deriveCdpHealth(collateral(), instance(), emptyAgg);
    expect(h.state).toBe("healthy");
    expect(h.reasons).toContain("No outstanding debt");
  });

  it("returns unknown when aggregates are truncated AND SP has some balance", () => {
    // For non-zero SP, we can't reason about coverage ratios under truncation;
    // misclassifying a borderline-healthy market as critical is worse than
    // refusing to render. (When SP is empty, the verdict is critical regardless
    // — see the separate test below.)
    const h = deriveCdpHealth(
      collateral(),
      instance({ spDeposits: "200000000000000000000" }),
      {
        openTroveCount: 50,
        totalDebt: BigInt("1000000000000000000000"),
        totalColl: BigInt(0),
        truncated: true,
      },
    );
    expect(h.state).toBe("unknown");
    expect(h.reasons[0]).toMatch(/truncated/i);
  });

  it("returns critical even when truncated if SP is empty and any debt is visible", () => {
    // Unseen debt past the row cap can only keep SP coverage at 0% (it cannot
    // make a 0-SP system suddenly look healthy), so refusing to render here
    // would obscure a real alert. The truncation note still shows in reasons.
    const h = deriveCdpHealth(collateral(), instance({ spDeposits: "0" }), {
      openTroveCount: 500,
      totalDebt: BigInt("1000000000000000000000"),
      totalColl: BigInt(0),
      truncated: true,
    });
    expect(h.state).toBe("critical");
    expect(h.reasons[0]).toMatch(/Stability Pool is empty/i);
    // Truncation is still noted so operators see why other ratios are missing.
    expect(h.reasons.some((r) => /truncated/i.test(r))).toBe(true);
  });
});
