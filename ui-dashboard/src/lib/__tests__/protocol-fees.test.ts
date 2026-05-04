import { describe, it, expect, vi, afterEach } from "vitest";
import {
  aggregateProtocolFees,
  aggregateProtocolFeesByPool,
  PROTOCOL_FEE_QUERY_LIMIT,
} from "../protocol-fees";
import { tokenToUSD, type OracleRateMap } from "../tokens";
import type { ProtocolFeeTransfer } from "../types";

const TEST_RATES: OracleRateMap = new Map([
  ["cEUR", 1.1455],
  ["EURm", 1.1455],
  ["GBPm", 1.3263],
  ["AUDm", 0.6993],
  ["CADm", 0.7299],
  ["CHFm", 1.2674],
  ["KESm", 0.0077],
  ["BRLm", 0.1905],
  ["COPm", 0.00027],
  ["GHSm", 0.0924],
  ["JPYm", 0.00627],
  ["NGNm", 0.00073],
  ["PHPm", 0.01675],
  ["XOFm", 0.00175],
  ["ZARm", 0.0593],
  ["axlEUROC", 1.1455],
]);

// tokenToUSD
describe("tokenToUSD", () => {
  it("returns amount unchanged for USD-pegged tokens", () => {
    expect(tokenToUSD("USDm", 100, TEST_RATES)).toBe(100);
    expect(tokenToUSD("USDC", 50, TEST_RATES)).toBe(50);
    expect(tokenToUSD("USDT", 25, TEST_RATES)).toBe(25);
    // USD₮ (U+20AE) is how USDT appears on Celo — same $1 peg
    expect(tokenToUSD("USD₮", 25, TEST_RATES)).toBe(25);
    expect(tokenToUSD("cUSD", 10, TEST_RATES)).toBe(10);
    expect(tokenToUSD("axlUSDC", 5, TEST_RATES)).toBe(5);
  });

  it("converts GBPm at FX rate", () => {
    expect(tokenToUSD("GBPm", 100, TEST_RATES)).toBeCloseTo(132.63, 1);
  });

  it("converts EURm at FX rate", () => {
    expect(tokenToUSD("EURm", 100, TEST_RATES)).toBeCloseTo(114.55, 1);
  });

  it("converts cEUR at FX rate (legacy symbol)", () => {
    expect(tokenToUSD("cEUR", 100, TEST_RATES)).toBeCloseTo(114.55, 1);
  });

  it("converts AUSD at 1:1 (USD-pegged)", () => {
    expect(tokenToUSD("AUSD", 100, TEST_RATES)).toBe(100);
  });

  it("converts KESm at FX rate", () => {
    expect(tokenToUSD("KESm", 1000, TEST_RATES)).toBeCloseTo(7.7, 1);
  });

  it("converts AUDm at FX rate", () => {
    expect(tokenToUSD("AUDm", 100, TEST_RATES)).toBeCloseTo(69.93, 2);
  });

  it("converts CADm at FX rate", () => {
    expect(tokenToUSD("CADm", 100, TEST_RATES)).toBeCloseTo(72.99, 2);
  });

  it("converts CHFm at FX rate", () => {
    expect(tokenToUSD("CHFm", 100, TEST_RATES)).toBeCloseTo(126.74, 2);
  });

  it("converts BRLm at FX rate", () => {
    expect(tokenToUSD("BRLm", 100, TEST_RATES)).toBeCloseTo(19.05, 2);
  });

  it("converts COPm at FX rate", () => {
    expect(tokenToUSD("COPm", 100, TEST_RATES)).toBeCloseTo(0.027, 3);
  });

  it("converts GHSm at FX rate", () => {
    expect(tokenToUSD("GHSm", 100, TEST_RATES)).toBeCloseTo(9.24, 2);
  });

  it("converts JPYm at FX rate", () => {
    expect(tokenToUSD("JPYm", 100, TEST_RATES)).toBeCloseTo(0.627, 3);
  });

  it("converts NGNm at FX rate", () => {
    expect(tokenToUSD("NGNm", 100, TEST_RATES)).toBeCloseTo(0.073, 3);
  });

  it("converts PHPm at FX rate", () => {
    expect(tokenToUSD("PHPm", 100, TEST_RATES)).toBeCloseTo(1.675, 3);
  });

  it("converts XOFm at FX rate", () => {
    expect(tokenToUSD("XOFm", 100, TEST_RATES)).toBeCloseTo(0.175, 3);
  });

  it("converts ZARm at FX rate", () => {
    expect(tokenToUSD("ZARm", 100, TEST_RATES)).toBeCloseTo(5.93, 2);
  });

  it("converts axlEUROC at FX rate (EUR-pegged)", () => {
    const usd = tokenToUSD("axlEUROC", 100, TEST_RATES);
    expect(usd).not.toBeNull();
    expect(usd!).toBeCloseTo(114.55, 1);
  });

  it("returns null for unknown tokens", () => {
    expect(tokenToUSD("UNKNOWN", 100, TEST_RATES)).toBeNull();
    expect(tokenToUSD("FOO", 50, TEST_RATES)).toBeNull();
  });
});

// aggregateProtocolFees

/** Helper to build a transfer with sensible defaults. */
function transfer(
  overrides: Partial<ProtocolFeeTransfer> = {},
): ProtocolFeeTransfer {
  return {
    chainId: 42220,

    tokenSymbol: "USDm",
    tokenDecimals: 18,
    amount: "1000000000000000000", // 1e18 = 1 token
    blockTimestamp: "0", // old by default
    from: "0x0000000000000000000000000000000000000000",
    ...overrides,
  };
}

describe("aggregateProtocolFees", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero totals for empty array", () => {
    const result = aggregateProtocolFees([], TEST_RATES);
    expect(result.totalFeesUSD).toBe(0);
    expect(result.fees24hUSD).toBe(0);
    expect(result.unpricedSymbols).toEqual([]);
  });

  it("sums USD-pegged tokens at 1:1", () => {
    const transfers = [
      transfer({ amount: "1000000000000000000" }), // 1 USDm
      transfer({ amount: "2000000000000000000" }), // 2 USDm
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(3, 2);
    expect(result.fees24hUSD).toBe(0); // all old timestamps
  });

  it("handles 6-decimal tokens (USDC)", () => {
    const transfers = [
      transfer({
        chainId: 42220,

        tokenSymbol: "USDC",
        tokenDecimals: 6,
        amount: "1500000", // 1.5 USDC
      }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(1.5, 4);
  });

  it("applies FX rates for non-USD tokens", () => {
    const transfers = [
      transfer({
        chainId: 42220,

        tokenSymbol: "GBPm",
        tokenDecimals: 18,
        amount: "1000000000000000000", // 1 GBPm
      }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(1.3263, 2); // 1 * 1.3263
  });

  it("splits 24h/7d/30d fees correctly", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({ blockTimestamp: "100" }), // old (outside 30d)
      transfer({ blockTimestamp: String(now - 20 * 86400) }), // 20d ago (within 30d, outside 7d)
      transfer({ blockTimestamp: String(now - 3 * 86400) }), // 3d ago (within 7d, outside 24h)
      transfer({ blockTimestamp: String(now - 3600) }), // 1h ago (within 24h)
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(4, 2);
    expect(result.fees24hUSD).toBeCloseTo(1, 2);
    expect(result.fees7dUSD).toBeCloseTo(2, 2);
    expect(result.fees30dUSD).toBeCloseTo(3, 2);
  });

  it("silently skips UNKNOWN (indexer placeholder) without flagging as unpriced", () => {
    const transfers = [
      transfer({
        chainId: 42220,
        tokenSymbol: "UNKNOWN",
        amount: "1000000000000000000",
      }),
      transfer({
        chainId: 42220,
        tokenSymbol: "USDm",
        amount: "1000000000000000000",
      }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.unpricedSymbols).toEqual([]);
    expect(result.totalFeesUSD).toBeCloseTo(1, 2);
  });

  it("reports unpriced symbols when genuinely unknown tokens appear", () => {
    const transfers = [
      transfer({
        chainId: 42220,
        tokenSymbol: "NEWTOK",
        amount: "1000000000000000000",
      }),
      transfer({
        chainId: 42220,
        tokenSymbol: "USDm",
        amount: "1000000000000000000",
      }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.unpricedSymbols).toEqual(["NEWTOK"]);
    // Unpriced token excluded from USD total
    expect(result.totalFeesUSD).toBeCloseTo(1, 2);
  });

  it("returns empty unpricedSymbols when all tokens are known", () => {
    const transfers = [
      transfer({ chainId: 42220, tokenSymbol: "USDm" }),
      transfer({
        chainId: 42220,
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        amount: "1000000",
      }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.unpricedSymbols).toEqual([]);
  });

  it("handles mixed decimals and currencies", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({
        chainId: 42220,
        tokenSymbol: "USDm",
        amount: "10000000000000000000",
      }), // 10 USDm
      transfer({
        chainId: 42220,

        tokenSymbol: "USDC",
        tokenDecimals: 6,
        amount: "5000000", // 5 USDC
        blockTimestamp: String(now - 100),
      }),
      transfer({
        chainId: 42220,

        tokenSymbol: "GBPm",
        amount: "2000000000000000000", // 2 GBPm = 2.54 USD
      }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.totalFeesUSD).toBeCloseTo(10 + 5 + 2 * 1.3263, 1);
    expect(result.fees24hUSD).toBeCloseTo(5, 2); // only USDC is recent
  });

  it("sets isTruncated=false when below query limit", () => {
    const transfers = [transfer(), transfer()];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.isTruncated).toBe(false);
  });

  it("sets isTruncated=true when transfers hit the query limit", () => {
    const transfers = Array.from({ length: PROTOCOL_FEE_QUERY_LIMIT }, () =>
      transfer(),
    );
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.isTruncated).toBe(true);
  });

  it("unpricedSymbols24h: includes unpriced symbol in 24h window", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({
        chainId: 42220,

        tokenSymbol: "SOMENEWTOK",
        blockTimestamp: String(now - 3600), // 1h ago — within 24h
      }),
      transfer({ chainId: 42220, tokenSymbol: "USDm" }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.unpricedSymbols).toContain("SOMENEWTOK");
    expect(result.unpricedSymbols24h).toContain("SOMENEWTOK");
  });

  it("unpricedSymbols24h: excludes unpriced symbol outside 24h window", () => {
    const transfers = [
      transfer({
        chainId: 42220,

        tokenSymbol: "OLDTOK",
        blockTimestamp: "100", // very old — outside 24h
      }),
      transfer({ chainId: 42220, tokenSymbol: "USDm" }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.unpricedSymbols).toContain("OLDTOK");
    expect(result.unpricedSymbols24h).not.toContain("OLDTOK");
    // 24h fees should be exact even though all-time has unpriced symbols
    expect(result.unpricedSymbols24h).toHaveLength(0);
  });

  it("unresolvedCount: counts UNKNOWN transfers without marking them as unpriced", () => {
    const transfers = [
      transfer({ chainId: 42220, tokenSymbol: "UNKNOWN" }),
      transfer({ chainId: 42220, tokenSymbol: "UNKNOWN" }),
      transfer({ chainId: 42220, tokenSymbol: "USDm" }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.unresolvedCount).toBe(2);
    expect(result.unresolvedCount24h).toBe(0); // old timestamps by default
    expect(result.unpricedSymbols).toHaveLength(0);
    expect(result.totalFeesUSD).toBeCloseTo(1, 2); // only USDm counted
  });

  it("unresolvedCount24h: counts recent UNKNOWN transfers for 24h approximation", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({
        chainId: 42220,
        tokenSymbol: "UNKNOWN",
        blockTimestamp: "100",
      }), // old
      transfer({
        chainId: 42220,

        tokenSymbol: "UNKNOWN",
        blockTimestamp: String(now - 3600),
      }), // 1h ago — within 24h
      transfer({ chainId: 42220, tokenSymbol: "USDm" }),
    ];
    const result = aggregateProtocolFees(transfers, TEST_RATES);
    expect(result.unresolvedCount).toBe(2);
    expect(result.unresolvedCount24h).toBe(1); // only the recent UNKNOWN
    expect(result.fees24hUSD).toBeCloseTo(0, 2); // UNKNOWN excluded from total
  });
});

describe("aggregateProtocolFeesByPool", () => {
  const POOL_A = "0xaaaa000000000000000000000000000000000001";
  const POOL_B = "0xbbbb000000000000000000000000000000000002";

  it("groups transfers by pool address and chain", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({
        from: POOL_A,
        amount: "1000000000000000000", // 1 USDm
        blockTimestamp: String(now - 1800), // 30m ago
      }),
      transfer({
        from: POOL_A,
        amount: "2000000000000000000", // 2 USDm
        blockTimestamp: String(now - 3 * 86400), // 3 days ago
      }),
      transfer({
        from: POOL_B,
        amount: "5000000000000000000", // 5 USDm
        blockTimestamp: String(now - 1800),
      }),
    ];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    expect(entries).toHaveLength(2);
    const a = entries.find((e) => e.poolAddress === POOL_A)!;
    const b = entries.find((e) => e.poolAddress === POOL_B)!;
    expect(a.poolId).toBe(`42220-${POOL_A}`);
    expect(a.fees24hUSD).toBeCloseTo(1, 2);
    expect(a.fees7dUSD).toBeCloseTo(3, 2);
    expect(a.totalFeesUSD).toBeCloseTo(3, 2);
    expect(b.fees24hUSD).toBeCloseTo(5, 2);
    expect(b.totalFeesUSD).toBeCloseTo(5, 2);
  });

  it("sum across pools matches the chain-level aggregate", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({
        from: POOL_A,
        amount: "1000000000000000000",
        blockTimestamp: String(now - 1800),
      }),
      transfer({
        from: POOL_A,
        tokenSymbol: "EURm",
        amount: "1000000000000000000",
        blockTimestamp: String(now - 1800),
      }),
      transfer({
        from: POOL_B,
        amount: "3000000000000000000",
        blockTimestamp: String(now - 5 * 86400),
      }),
    ];
    const chain = aggregateProtocolFees(transfers, TEST_RATES);
    const pools = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    const sum24h = pools.reduce((s, p) => s + p.fees24hUSD, 0);
    const sum7d = pools.reduce((s, p) => s + p.fees7dUSD, 0);
    const sumAll = pools.reduce((s, p) => s + p.totalFeesUSD, 0);
    expect(sum24h).toBeCloseTo(chain.fees24hUSD, 5);
    expect(sum7d).toBeCloseTo(chain.fees7dUSD, 5);
    expect(sumAll).toBeCloseTo(chain.totalFeesUSD, 5);
  });

  it("flags pools with unpriced or unknown tokens", () => {
    const transfers = [
      transfer({ from: POOL_A, tokenSymbol: "USDm" }),
      transfer({ from: POOL_B, tokenSymbol: "MYSTERY" }),
    ];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    expect(entries.find((e) => e.poolAddress === POOL_A)!.unpriced).toBe(false);
    expect(entries.find((e) => e.poolAddress === POOL_B)!.unpriced).toBe(true);
  });

  it("window-scoped unpriced flags: OLD unpriced transfer doesn't pollute recent windows", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      // Unpriced transfer 6 months ago (outside 30d/7d/24h)
      transfer({
        from: POOL_A,
        tokenSymbol: "MYSTERY",
        blockTimestamp: String(now - 180 * 86400),
      }),
      // Recent priced transfer (1h ago, inside all windows)
      transfer({
        from: POOL_A,
        tokenSymbol: "USDm",
        blockTimestamp: String(now - 3600),
      }),
    ];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    const a = entries.find((e) => e.poolAddress === POOL_A)!;
    // All-time aggregate is approximate (lower bound).
    expect(a.unpriced).toBe(true);
    // 24h/7d/30d cells are exact — unpriced transfer is outside their windows.
    expect(a.unpriced24h).toBe(false);
    expect(a.unpriced7d).toBe(false);
    expect(a.unpriced30d).toBe(false);
  });

  it("window-scoped unpriced flags: recent unpriced transfer marks the right windows", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      // Unpriced transfer 3 days ago — inside 7d and 30d, outside 24h
      transfer({
        from: POOL_A,
        tokenSymbol: "MYSTERY",
        blockTimestamp: String(now - 3 * 86400),
      }),
    ];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    const a = entries.find((e) => e.poolAddress === POOL_A)!;
    expect(a.unpriced).toBe(true);
    expect(a.unpriced24h).toBe(false);
    expect(a.unpriced7d).toBe(true);
    expect(a.unpriced30d).toBe(true);
  });

  it("window-scoped unpriced flags: UNKNOWN placeholder is treated identically to unpriced symbol", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({
        from: POOL_A,
        tokenSymbol: "UNKNOWN",
        blockTimestamp: String(now - 1800), // 30m ago — inside all windows
      }),
    ];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    const a = entries.find((e) => e.poolAddress === POOL_A)!;
    expect(a.unpriced).toBe(true);
    expect(a.unpriced24h).toBe(true);
    expect(a.unpriced7d).toBe(true);
    expect(a.unpriced30d).toBe(true);
  });

  it("normalizes mixed-case pool addresses to lowercase", () => {
    const transfers = [
      transfer({ from: POOL_A.toUpperCase() }),
      transfer({ from: POOL_A }),
    ];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    expect(entries).toHaveLength(1);
    expect(entries[0].poolAddress).toBe(POOL_A);
  });

  it("emits one entry per (chain, address) tuple", () => {
    const transfers = [
      transfer({ chainId: 42220, from: POOL_A }),
      transfer({ chainId: 143, from: POOL_A }),
    ];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    expect(entries).toHaveLength(2);
    const ids = new Set(entries.map((e) => e.poolId));
    expect(ids.has(`42220-${POOL_A}`)).toBe(true);
    expect(ids.has(`143-${POOL_A}`)).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(aggregateProtocolFeesByPool([], TEST_RATES)).toEqual([]);
  });

  it("skips transfers with empty `from`", () => {
    const transfers = [transfer({ from: "" }), transfer({ from: POOL_A })];
    const entries = aggregateProtocolFeesByPool(transfers, TEST_RATES);
    expect(entries).toHaveLength(1);
    expect(entries[0].poolAddress).toBe(POOL_A);
  });
});
