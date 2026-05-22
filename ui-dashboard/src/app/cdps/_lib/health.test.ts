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
  redemptionDebtCum: "0",
  redemptionFeeCum: "0",
  rebalanceRedemptionCountCum: 0,
  rebalanceRedemptionDebtCum: "0",
  rebalanceRedemptionFeeCum: "0",
  borrowingFeeCum: "0",
  isShutDown: false,
  shutDownAt: null,
  shutDownTcrBps: null,
  lastEventBlock: "0",
  lastEventTimestamp: "0",
  ...overrides,
});

const trove = (status: string): Pick<CdpTrove, "status"> => ({ status });

describe("aggregateTroves", () => {
  it("counts active and zombie troves, skipping closed/liquidated/redeemed", () => {
    const result = aggregateTroves([
      trove("active"),
      trove("zombie"),
      trove("closed"),
      trove("liquidated"),
      trove("redeemed"),
    ]);
    expect(result.openTroveCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("returns zeros for empty input", () => {
    expect(aggregateTroves([])).toEqual({
      openTroveCount: 0,
      truncated: false,
    });
  });

  it("propagates truncated flag from options", () => {
    const result = aggregateTroves([trove("active")], { truncated: true });
    expect(result.truncated).toBe(true);
  });
});

describe("aggregatesForCollateral (list-page lookup)", () => {
  const fullAgg: CdpAggregates = {
    openTroveCount: 3,
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
    // rendering as "0 open troves" instead of "≥ 0".
    const map = new Map([["42220-A", fullAgg]]);
    const result = aggregatesForCollateral("42220-Missing", map, true);
    expect(result.openTroveCount).toBe(0);
    expect(result.truncated).toBe(true);
  });
});

describe("deriveCdpHealth", () => {
  it("shutdown takes precedence over everything", () => {
    const h = deriveCdpHealth(
      collateral(),
      instance({
        isShutDown: true,
        systemDebt: "1000",
        spDeposits: "999999999999999999999999",
      }),
    );
    expect(h.state).toBe("shutdown");
  });

  it("notes unloaded system params in reasons but does not force unknown", () => {
    const h = deriveCdpHealth(
      collateral({ systemParamsLoaded: false }),
      instance(),
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
      instance({
        spDeposits: "0",
        systemDebt: "314000000000000000000000",
      }),
    );
    expect(h.state).toBe("critical");
    expect(h.reasons).toContain("System params not yet loaded");
  });

  it("returns unknown when instance is missing", () => {
    const h = deriveCdpHealth(collateral(), undefined);
    expect(h.state).toBe("unknown");
  });

  it("critical when SP is empty and there is outstanding debt", () => {
    const h = deriveCdpHealth(
      collateral(),
      instance({
        spDeposits: "0",
        systemDebt: "1000000000000000000000",
      }),
    );
    expect(h.state).toBe("critical");
    expect(h.reasons[0]).toMatch(/Stability Pool is empty/i);
  });

  it("critical when SP covers under 5% of debt", () => {
    // 49 / 1000 = 4.9% → critical
    const h = deriveCdpHealth(
      collateral(),
      instance({
        spDeposits: "49000000000000000000",
        systemDebt: "1000000000000000000000",
      }),
    );
    expect(h.state).toBe("critical");
  });

  it("warning when SP covers 5-50% of debt", () => {
    // 200 / 1000 = 20% → warning
    const h = deriveCdpHealth(
      collateral(),
      instance({
        spDeposits: "200000000000000000000",
        systemDebt: "1000000000000000000000",
      }),
    );
    expect(h.state).toBe("warning");
  });

  it("healthy when SP covers 50%+ of debt", () => {
    // 800 / 1000 = 80% → healthy
    const h = deriveCdpHealth(
      collateral(),
      instance({
        spDeposits: "800000000000000000000",
        systemDebt: "1000000000000000000000",
      }),
    );
    expect(h.state).toBe("healthy");
  });

  it("healthy (no-debt informational reason) when system has no troves", () => {
    const h = deriveCdpHealth(collateral(), instance());
    expect(h.state).toBe("healthy");
    expect(h.reasons).toContain("No outstanding debt");
  });
});
