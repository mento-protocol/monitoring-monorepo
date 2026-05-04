import { describe, it, expect } from "vitest";
import { aggregateFeeSnapshotsByPool } from "../protocol-fee-snapshots";
import type { OracleRateMap } from "../tokens";
import type { PoolDailyFeeSnapshot } from "../types";

const TEST_RATES: OracleRateMap = new Map([
  ["EURm", 1.1455],
  ["GBPm", 1.3263],
  ["JPYm", 0.00627],
  ["BRLm", 0.1905],
]);

const POOL_A = "0xaaaa000000000000000000000000000000000001";
const POOL_B = "0xbbbb000000000000000000000000000000000002";
const CHAIN = 42220;

const SECS_PER_DAY = 86_400;
const DAY = (offsetDays: number, now: number) =>
  String(
    Math.floor((now - offsetDays * SECS_PER_DAY) / SECS_PER_DAY) * SECS_PER_DAY,
  );

/** Helper to build a PoolDailyFeeSnapshot fixture with sensible defaults. */
function snapshot(
  overrides: Partial<PoolDailyFeeSnapshot> = {},
): PoolDailyFeeSnapshot {
  const dayTs = overrides.timestamp ?? "0";
  const poolAddress = overrides.poolAddress ?? POOL_A;
  return {
    id: `${CHAIN}-${poolAddress}-${dayTs}`,
    chainId: CHAIN,
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

describe("aggregateFeeSnapshotsByPool", () => {
  it("returns empty array for empty input", () => {
    expect(aggregateFeeSnapshotsByPool([], TEST_RATES, CHAIN)).toEqual([]);
  });

  it("sums all-pegged single-day snapshot via feesUsdWei alone", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshots = [
      snapshot({
        timestamp: DAY(0, now),
        // 1.5 USDm in raw token-native; pegged so the indexer pre-summed
        // into feesUsdWei (18-dp USD-wei) → "1500000000000000000".
        tokens: ["0xabc"],
        tokenSymbols: ["USDm"],
        tokenDecimals: [18],
        amounts: ["1500000000000000000"],
        feesUsdWei: "1500000000000000000",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(snapshots, TEST_RATES, CHAIN);
    expect(entries).toHaveLength(1);
    const a = entries[0];
    expect(a.poolAddress).toBe(POOL_A);
    expect(a.poolId).toBe(`${CHAIN}-${POOL_A}`);
    expect(a.totalFeesUSD).toBeCloseTo(1.5, 4);
    expect(a.fees24hUSD).toBeCloseTo(1.5, 4);
    expect(a.fees7dUSD).toBeCloseTo(1.5, 4);
    expect(a.fees30dUSD).toBeCloseTo(1.5, 4);
    expect(a.unpriced).toBe(false);
  });

  it("prices FX-only snapshot via the oracle rate map", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshots = [
      snapshot({
        timestamp: DAY(0, now),
        tokens: ["0xgbp"],
        tokenSymbols: ["GBPm"],
        tokenDecimals: [18],
        // 100 GBPm
        amounts: ["100000000000000000000"],
        feesUsdWei: "0",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(snapshots, TEST_RATES, CHAIN);
    expect(entries[0].totalFeesUSD).toBeCloseTo(132.63, 1);
    expect(entries[0].unpriced).toBe(false);
  });

  it("doesn't double-count mixed pegged + FX (pegged in feesUsdWei, FX in arrays)", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshots = [
      snapshot({
        timestamp: DAY(0, now),
        // Two slots: 5 USDm (pegged, already in feesUsdWei) + 100 EURm (FX)
        tokens: ["0xusd", "0xeur"],
        tokenSymbols: ["USDm", "EURm"],
        tokenDecimals: [18, 18],
        amounts: ["5000000000000000000", "100000000000000000000"],
        // feesUsdWei carries ONLY the pegged side (5 USD) per the indexer's
        // hybrid pricing contract.
        feesUsdWei: "5000000000000000000",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(snapshots, TEST_RATES, CHAIN);
    // 5 USD + 100 EUR × 1.1455 = 5 + 114.55 = 119.55
    expect(entries[0].totalFeesUSD).toBeCloseTo(119.55, 1);
    expect(entries[0].unpriced).toBe(false);
  });

  it("sums multi-day snapshots in same pool — all-time = sum of per-day rows", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshots = [
      // Today: 1 USDm
      snapshot({
        timestamp: DAY(0, now),
        feesUsdWei: "1000000000000000000",
      }),
      // 5 days ago: 2 USDm
      snapshot({
        timestamp: DAY(5, now),
        feesUsdWei: "2000000000000000000",
      }),
      // 20 days ago: 4 USDm
      snapshot({
        timestamp: DAY(20, now),
        feesUsdWei: "4000000000000000000",
      }),
      // 100 days ago: 8 USDm (outside 30d window)
      snapshot({
        timestamp: DAY(100, now),
        feesUsdWei: "8000000000000000000",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(snapshots, TEST_RATES, CHAIN);
    expect(entries).toHaveLength(1);
    const a = entries[0];
    expect(a.fees24hUSD).toBeCloseTo(1, 4);
    expect(a.fees7dUSD).toBeCloseTo(3, 4); // today + 5d
    expect(a.fees30dUSD).toBeCloseTo(7, 4); // today + 5d + 20d
    expect(a.totalFeesUSD).toBeCloseTo(15, 4); // all four
  });

  it("UNKNOWN slot flips unpriced=true; pegged total still preserved", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshots = [
      snapshot({
        timestamp: DAY(0, now),
        tokens: ["0xusd", "0x???"],
        tokenSymbols: ["USDm", "UNKNOWN"],
        tokenDecimals: [18, 18],
        amounts: ["3000000000000000000", "1000000000000000000"],
        feesUsdWei: "3000000000000000000", // pegged side only
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(snapshots, TEST_RATES, CHAIN);
    expect(entries[0].unpriced).toBe(true);
    expect(entries[0].totalFeesUSD).toBeCloseTo(3, 4);
  });

  it("missing FX rate flips unpriced=true; pegged side preserved", () => {
    const now = Math.floor(Date.now() / 1000);
    const ratesWithoutGBP: OracleRateMap = new Map([["EURm", 1.1455]]);
    const snapshots = [
      snapshot({
        timestamp: DAY(0, now),
        tokens: ["0xusd", "0xgbp"],
        tokenSymbols: ["USDm", "GBPm"],
        tokenDecimals: [18, 18],
        amounts: ["3000000000000000000", "100000000000000000000"],
        feesUsdWei: "3000000000000000000",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(
      snapshots,
      ratesWithoutGBP,
      CHAIN,
    );
    expect(entries[0].unpriced).toBe(true);
    // 3 USD pegged still flowed through — GBPm slot dropped because no rate.
    expect(entries[0].totalFeesUSD).toBeCloseTo(3, 4);
  });

  it("window cutoff edge: snapshot at now-24h-1 falls outside 24h, inside 7d", () => {
    const now = 7 * SECS_PER_DAY + 100; // ensure cutoffs are clean
    // Snapshot day-bucket exactly one second past the 24h cutoff. The cutoff
    // is `now - 86400 = 6*86400 + 100`. Day bucket at `now - 86400 - 1`
    // truncates to UTC midnight `(now - 86400 - 1) / 86400 * 86400`. For
    // any reasonable `now`, that bucket is at most `now - 86400 - 1` and
    // strictly less than the cutoff — so it's NOT in 24h.
    const snapshots = [
      snapshot({
        timestamp: String(
          Math.floor((now - SECS_PER_DAY - 1) / SECS_PER_DAY) * SECS_PER_DAY,
        ),
        feesUsdWei: "5000000000000000000",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(
      snapshots,
      TEST_RATES,
      CHAIN,
      now,
    );
    expect(entries[0].fees24hUSD).toBe(0);
    expect(entries[0].fees7dUSD).toBeCloseTo(5, 4);
    expect(entries[0].fees30dUSD).toBeCloseTo(5, 4);
    expect(entries[0].totalFeesUSD).toBeCloseTo(5, 4);
  });

  it("emits one entry per (chain, address) tuple", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshots = [
      snapshot({
        poolAddress: POOL_A,
        timestamp: DAY(0, now),
        feesUsdWei: "1000000000000000000",
      }),
      snapshot({
        poolAddress: POOL_B,
        timestamp: DAY(0, now),
        feesUsdWei: "2000000000000000000",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(snapshots, TEST_RATES, CHAIN);
    expect(entries).toHaveLength(2);
    const a = entries.find((e) => e.poolAddress === POOL_A)!;
    const b = entries.find((e) => e.poolAddress === POOL_B)!;
    expect(a.totalFeesUSD).toBeCloseTo(1, 4);
    expect(b.totalFeesUSD).toBeCloseTo(2, 4);
  });

  it("normalizes mixed-case poolAddress to lowercase in entry key", () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshots = [
      snapshot({
        poolAddress: POOL_A.toUpperCase(),
        timestamp: DAY(0, now),
        feesUsdWei: "1000000000000000000",
      }),
      snapshot({
        poolAddress: POOL_A,
        timestamp: DAY(1, now),
        feesUsdWei: "2000000000000000000",
      }),
    ];
    const entries = aggregateFeeSnapshotsByPool(snapshots, TEST_RATES, CHAIN);
    expect(entries).toHaveLength(1);
    expect(entries[0].poolAddress).toBe(POOL_A);
    expect(entries[0].totalFeesUSD).toBeCloseTo(3, 4);
  });
});
