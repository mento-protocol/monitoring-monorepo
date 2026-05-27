import { describe, expect, it } from "vitest";
import {
  formatOracleChartHoverText,
  resolveSnapshotBand,
} from "../oracle-chart";
import type { OracleSnapshot } from "@/lib/types";

// Fixidity is 1e24 — encode the Mento contract scale. Strings here mirror
// the Hasura wire format (BigInt → JSON string) the chart actually sees.
// 1.05 × 1e24 → "1050000000000000000000000". The threshold 0.001 (10 bps)
// is also Fixidity, so 0.001 × 1e24 → "1000000000000000000000".
const FIXIDITY_ONE_05 = "1050000000000000000000000"; // 1.05
const FIXIDITY_ZERO_001 = "1000000000000000000000"; // 0.001 = 10bps

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

  it("uses 'at the time' wording for historical band verdicts", () => {
    // When the indexer persists the breaker baseline on the snapshot row,
    // the chart's verdict isn't a "current-lens" check — it's the actual
    // at-the-time evaluation. The hover wording must reflect that so an
    // operator reading a green dot doesn't think "this passes today."
    const ok = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 1.0005,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      isHistoricalBand: true,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });
    expect(ok).toContain("within band at the time");

    const breach = formatOracleChartHoverText({
      snapshot: oracleSnapshot(),
      price: 0.998,
      baseline: 1.0,
      thresholdRatio: 0.0015,
      isHistoricalBand: true,
      token0Symbol: "cUSD",
      token1Symbol: "USDC",
    });
    expect(breach).toContain("would have tripped at the time");
  });
});

describe("resolveSnapshotBand", () => {
  it("prefers persisted per-snapshot baseline + threshold over current config", () => {
    // Spec for the PR-624 follow-up: a snapshot written with the indexer's
    // breakerBaselineAtSnapshot must override the live breaker config so
    // EMA drift between write-time and read-time can't flip a historical
    // verdict. 1.05 / 0.001 = the band that was actually armed when the
    // median landed; 1.10 / 0.003 = today's current band.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: FIXIDITY_ONE_05,
      breakerThresholdAtSnapshot: FIXIDITY_ZERO_001,
    });

    const resolved = resolveSnapshotBand(snapshot, 1.1, 0.003);

    expect(resolved.baseline).toBeCloseTo(1.05, 10);
    expect(resolved.thresholdRatio).toBeCloseTo(0.001, 10);
  });

  it("falls back to current config when per-snapshot fields are absent", () => {
    // Pre-deploy rows + rows from non-oracle sources (update_reserves,
    // rebalanced) explicitly null these fields. The chart should reuse the
    // current breaker config rather than refuse to render the verdict.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: null,
      breakerThresholdAtSnapshot: null,
    });

    const resolved = resolveSnapshotBand(snapshot, 1.08, 0.04);

    expect(resolved.baseline).toBeCloseTo(1.08, 10);
    expect(resolved.thresholdRatio).toBeCloseTo(0.04, 10);
  });

  it("falls back to current when one persisted field is null", () => {
    // Pair-of-two semantics — the indexer writes both fields together,
    // so a half-populated row indicates corruption. Refuse the partial
    // persisted pair and fall back rather than mixing a persisted
    // baseline with a current threshold.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: FIXIDITY_ONE_05,
      breakerThresholdAtSnapshot: null,
    });

    const resolved = resolveSnapshotBand(snapshot, 1.1, 0.003);

    expect(resolved.baseline).toBeCloseTo(1.1, 10);
    expect(resolved.thresholdRatio).toBeCloseTo(0.003, 10);
  });

  it("returns nulls when neither persisted nor current band is usable", () => {
    // No breaker exists for this feed, no historical anchor either —
    // markers should render as neutral / unknown, not greenwash to OK.
    const snapshot = oracleSnapshot({
      breakerBaselineAtSnapshot: null,
      breakerThresholdAtSnapshot: null,
    });

    const resolved = resolveSnapshotBand(snapshot, null, null);

    expect(resolved.baseline).toBeNull();
    expect(resolved.thresholdRatio).toBeNull();
  });
});
