import { describe, it, expect, vi, afterEach } from "vitest";
import { aggregateProtocolFees } from "../protocol-fees";
import { tokenToUSD, type OracleRateMap } from "../tokens";
import type { PoolDailyFeeSnapshot } from "../types";

const TEST_RATES: OracleRateMap = new Map([
  ["cEUR", 1.1455],
  ["EURm", 1.1455],
  ["GBPm", 1.3263],
  ["AUDm", 0.6993],
  ["CADm", 0.7299],
  ["CHFm", 1.2674],
  ["KESm", 0.0077],
  ["BRLm", 0.1905],
  ["JPYm", 0.00627],
  ["NGNm", 0.00073],
  ["axlEUROC", 1.1455],
]);

const SECS_PER_DAY = 86_400;
const NOW_S = Math.floor(Date.now() / 1000);
const DAY = (offsetDays: number) =>
  String(
    Math.floor((NOW_S - offsetDays * SECS_PER_DAY) / SECS_PER_DAY) *
      SECS_PER_DAY,
  );

// ---------------------------------------------------------------------------
// tokenToUSD smoke tests — kept here because tokens.ts has no dedicated suite
// and this is the file that drives chain-level USD conversion.
// ---------------------------------------------------------------------------

describe("tokenToUSD", () => {
  it("returns amount unchanged for USD-pegged tokens", () => {
    expect(tokenToUSD("USDm", 100, TEST_RATES)).toBe(100);
    expect(tokenToUSD("USDC", 50, TEST_RATES)).toBe(50);
    expect(tokenToUSD("USDT", 25, TEST_RATES)).toBe(25);
    expect(tokenToUSD("cUSD", 10, TEST_RATES)).toBe(10);
    expect(tokenToUSD("axlUSDC", 5, TEST_RATES)).toBe(5);
    expect(tokenToUSD("AUSD", 100, TEST_RATES)).toBe(100);
  });

  it("converts FX tokens at rate", () => {
    expect(tokenToUSD("GBPm", 100, TEST_RATES)).toBeCloseTo(132.63, 1);
    expect(tokenToUSD("EURm", 100, TEST_RATES)).toBeCloseTo(114.55, 1);
    expect(tokenToUSD("KESm", 1000, TEST_RATES)).toBeCloseTo(7.7, 1);
    expect(tokenToUSD("JPYm", 100, TEST_RATES)).toBeCloseTo(0.627, 3);
  });

  it("returns null for unknown tokens", () => {
    expect(tokenToUSD("UNKNOWN", 100, TEST_RATES)).toBeNull();
    expect(tokenToUSD("FOO", 50, TEST_RATES)).toBeNull();
  });

  it("converts legacy cEUR via alias", () => {
    expect(tokenToUSD("cEUR", 100, TEST_RATES)).toBeCloseTo(114.55, 1);
  });
});

// ---------------------------------------------------------------------------
// aggregateProtocolFees over PoolDailyFeeSnapshot rows
// ---------------------------------------------------------------------------

const POOL_A = "0xaaaa000000000000000000000000000000000001";
const POOL_B = "0xbbbb000000000000000000000000000000000002";

function snapshot(
  overrides: Partial<PoolDailyFeeSnapshot> = {},
): PoolDailyFeeSnapshot {
  const dayTs = overrides.timestamp ?? DAY(0);
  const poolAddress = overrides.poolAddress ?? POOL_A;
  return {
    id: `42220-${poolAddress}-${dayTs}`,
    chainId: 42220,
    poolAddress,
    timestamp: dayTs,
    tokens: [],
    tokenSymbols: [],
    tokenDecimals: [],
    amounts: [],
    feesUsdWei: "0",
    ...overrides,
  };
}

describe("aggregateProtocolFees (snapshot input)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zeros for empty input", () => {
    const result = aggregateProtocolFees([], TEST_RATES);
    expect(result.totalFeesUSD).toBe(0);
    expect(result.fees24hUSD).toBe(0);
    expect(result.fees7dUSD).toBe(0);
    expect(result.fees30dUSD).toBe(0);
    expect(result.unpricedSymbols).toEqual([]);
    expect(result.unresolvedCount).toBe(0);
  });

  it("sums pegged feesUsdWei across snapshots and splits by window", () => {
    const snapshots = [
      snapshot({ feesUsdWei: "1000000000000000000" }), // 1 USD today
      snapshot({ timestamp: DAY(5), feesUsdWei: "2000000000000000000" }), // 2 USD 5d ago
    ];
    const result = aggregateProtocolFees(snapshots, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(3, 4);
    expect(result.fees24hUSD).toBeCloseTo(1, 4);
    expect(result.fees7dUSD).toBeCloseTo(3, 4);
    expect(result.fees30dUSD).toBeCloseTo(3, 4);
  });

  it("FX-only snapshot prices via the rate map", () => {
    const snapshots = [
      snapshot({
        tokens: ["0xgbp"],
        tokenSymbols: ["GBPm"],
        tokenDecimals: [18],
        amounts: ["100000000000000000000"], // 100 GBPm
        feesUsdWei: "0",
      }),
    ];
    const result = aggregateProtocolFees(snapshots, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(132.63, 1);
    expect(result.fees24hUSD).toBeCloseTo(132.63, 1);
  });

  it("mixed pegged + FX snapshot doesn't double-count", () => {
    const snapshots = [
      snapshot({
        tokens: ["0xusd", "0xeur"],
        tokenSymbols: ["USDm", "EURm"],
        tokenDecimals: [18, 18],
        amounts: ["5000000000000000000", "100000000000000000000"],
        // feesUsdWei carries pegged side ONLY per indexer contract.
        feesUsdWei: "5000000000000000000",
      }),
    ];
    const result = aggregateProtocolFees(snapshots, TEST_RATES);
    // 5 USDm + 100 EURm × 1.1455 = 5 + 114.55
    expect(result.totalFeesUSD).toBeCloseTo(119.55, 1);
  });

  it("UNKNOWN slot increments unresolvedCount but doesn't flag unpricedSymbols", () => {
    const snapshots = [
      snapshot({
        tokens: ["0xusd", "0x???"],
        tokenSymbols: ["USDm", "UNKNOWN"],
        tokenDecimals: [18, 18],
        amounts: ["3000000000000000000", "1000000000000000000"],
        feesUsdWei: "3000000000000000000",
      }),
    ];
    const result = aggregateProtocolFees(snapshots, TEST_RATES);
    expect(result.unresolvedCount).toBe(1);
    expect(result.unresolvedCount24h).toBe(1);
    expect(result.unpricedSymbols).toEqual([]);
    expect(result.totalFeesUSD).toBeCloseTo(3, 4);
  });

  it("unpriced FX symbol (no rate) flags unpricedSymbols + unpricedSymbols24h", () => {
    const ratesWithoutGBP: OracleRateMap = new Map([["EURm", 1.1455]]);
    const snapshots = [
      snapshot({
        tokens: ["0xusd", "0xgbp"],
        tokenSymbols: ["USDm", "GBPm"],
        tokenDecimals: [18, 18],
        amounts: ["3000000000000000000", "100000000000000000000"],
        feesUsdWei: "3000000000000000000",
      }),
    ];
    const result = aggregateProtocolFees(snapshots, ratesWithoutGBP);
    expect(result.unpricedSymbols).toEqual(["GBPm"]);
    expect(result.unpricedSymbols24h).toEqual(["GBPm"]);
    expect(result.totalFeesUSD).toBeCloseTo(3, 4);
  });

  it("OLD UNKNOWN snapshot doesn't pollute 24h unresolvedCount24h", () => {
    const snapshots = [
      snapshot({
        timestamp: DAY(180),
        tokens: ["0x???"],
        tokenSymbols: ["UNKNOWN"],
        tokenDecimals: [18],
        amounts: ["1000000000000000000"],
        feesUsdWei: "0",
      }),
      snapshot({ feesUsdWei: "1000000000000000000" }),
    ];
    const result = aggregateProtocolFees(snapshots, TEST_RATES);
    expect(result.unresolvedCount).toBe(1);
    expect(result.unresolvedCount24h).toBe(0);
    expect(result.totalFeesUSD).toBeCloseTo(1, 4);
  });

  it("OLD unpriced FX doesn't pollute unpricedSymbols24h", () => {
    const ratesWithoutGBP: OracleRateMap = new Map();
    const snapshots = [
      snapshot({
        timestamp: DAY(180),
        tokens: ["0xgbp"],
        tokenSymbols: ["GBPm"],
        tokenDecimals: [18],
        amounts: ["100000000000000000000"],
        feesUsdWei: "0",
      }),
    ];
    const result = aggregateProtocolFees(snapshots, ratesWithoutGBP);
    expect(result.unpricedSymbols).toEqual(["GBPm"]);
    expect(result.unpricedSymbols24h).toEqual([]);
  });

  it("multi-day pegged snapshots split correctly across windows", () => {
    const snapshots = [
      snapshot({ timestamp: DAY(0), feesUsdWei: "1000000000000000000" }),
      snapshot({ timestamp: DAY(5), feesUsdWei: "2000000000000000000" }),
      snapshot({ timestamp: DAY(20), feesUsdWei: "4000000000000000000" }),
      snapshot({ timestamp: DAY(100), feesUsdWei: "8000000000000000000" }), // outside 30d
    ];
    const result = aggregateProtocolFees(snapshots, TEST_RATES);
    expect(result.fees24hUSD).toBeCloseTo(1, 4);
    expect(result.fees7dUSD).toBeCloseTo(3, 4);
    expect(result.fees30dUSD).toBeCloseTo(7, 4);
    expect(result.totalFeesUSD).toBeCloseTo(15, 4);
  });

  it("aggregates cleanly across multiple pools", () => {
    const snapshots = [
      snapshot({ poolAddress: POOL_A, feesUsdWei: "1000000000000000000" }),
      snapshot({ poolAddress: POOL_B, feesUsdWei: "2000000000000000000" }),
    ];
    const result = aggregateProtocolFees(snapshots, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(3, 4);
  });
});
