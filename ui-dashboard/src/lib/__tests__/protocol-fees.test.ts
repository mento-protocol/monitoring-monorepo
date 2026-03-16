import { describe, it, expect, vi, afterEach } from "vitest";
import {
  aggregateProtocolFees,
  tokenToUSD,
  PROTOCOL_FEE_QUERY_LIMIT,
} from "../protocol-fees";
import type { ProtocolFeeTransfer } from "../types";

// ---------------------------------------------------------------------------
// tokenToUSD
// ---------------------------------------------------------------------------
describe("tokenToUSD", () => {
  it("returns amount unchanged for USD-pegged tokens", () => {
    expect(tokenToUSD("USDm", 100)).toBe(100);
    expect(tokenToUSD("USDC", 50)).toBe(50);
    expect(tokenToUSD("USDT", 25)).toBe(25);
    // USD₮ (U+20AE) is how USDT appears on Celo — same $1 peg
    expect(tokenToUSD("USD₮", 25)).toBe(25);
    expect(tokenToUSD("cUSD", 10)).toBe(10);
    expect(tokenToUSD("axlUSDC", 5)).toBe(5);
  });

  it("converts GBPm at FX rate", () => {
    expect(tokenToUSD("GBPm", 100)).toBeCloseTo(132.63, 1);
  });

  it("converts EURm at FX rate", () => {
    expect(tokenToUSD("EURm", 100)).toBeCloseTo(114.55, 1);
  });

  it("converts cEUR at FX rate (legacy symbol)", () => {
    expect(tokenToUSD("cEUR", 100)).toBeCloseTo(114.55, 1);
  });

  it("converts AUSD at 1:1 (USD-pegged)", () => {
    expect(tokenToUSD("AUSD", 100)).toBe(100);
  });

  it("converts KESm at FX rate", () => {
    expect(tokenToUSD("KESm", 1000)).toBeCloseTo(7.7, 1);
  });

  it("converts AUDm at FX rate", () => {
    expect(tokenToUSD("AUDm", 100)).toBeCloseTo(69.93, 2);
  });

  it("converts CADm at FX rate", () => {
    expect(tokenToUSD("CADm", 100)).toBeCloseTo(72.99, 2);
  });

  it("converts CHFm at FX rate", () => {
    expect(tokenToUSD("CHFm", 100)).toBeCloseTo(126.74, 2);
  });

  it("converts BRLm at FX rate", () => {
    expect(tokenToUSD("BRLm", 100)).toBeCloseTo(19.05, 2);
  });

  it("converts COPm at FX rate", () => {
    expect(tokenToUSD("COPm", 100)).toBeCloseTo(0.027, 3);
  });

  it("converts GHSm at FX rate", () => {
    expect(tokenToUSD("GHSm", 100)).toBeCloseTo(9.24, 2);
  });

  it("converts JPYm at FX rate", () => {
    expect(tokenToUSD("JPYm", 100)).toBeCloseTo(0.627, 3);
  });

  it("converts NGNm at FX rate", () => {
    expect(tokenToUSD("NGNm", 100)).toBeCloseTo(0.073, 3);
  });

  it("converts PHPm at FX rate", () => {
    expect(tokenToUSD("PHPm", 100)).toBeCloseTo(1.675, 3);
  });

  it("converts XOFm at FX rate", () => {
    expect(tokenToUSD("XOFm", 100)).toBeCloseTo(0.175, 3);
  });

  it("converts ZARm at FX rate", () => {
    expect(tokenToUSD("ZARm", 100)).toBeCloseTo(5.93, 2);
  });

  it("converts axlEUROC at FX rate (EUR-pegged)", () => {
    const usd = tokenToUSD("axlEUROC", 100);
    expect(usd).not.toBeNull();
    expect(usd!).toBeCloseTo(114.55, 1);
  });

  it("returns null for unknown tokens", () => {
    expect(tokenToUSD("UNKNOWN", 100)).toBeNull();
    expect(tokenToUSD("FOO", 50)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// aggregateProtocolFees
// ---------------------------------------------------------------------------

/** Helper to build a transfer with sensible defaults. */
function transfer(
  overrides: Partial<ProtocolFeeTransfer> = {},
): ProtocolFeeTransfer {
  return {
    tokenSymbol: "USDm",
    tokenDecimals: 18,
    amount: "1000000000000000000", // 1e18 = 1 token
    blockTimestamp: "0", // old by default
    ...overrides,
  };
}

describe("aggregateProtocolFees", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero totals for empty array", () => {
    const result = aggregateProtocolFees([]);
    expect(result.totalFeesUSD).toBe(0);
    expect(result.fees24hUSD).toBe(0);
    expect(result.unpricedSymbols).toEqual([]);
  });

  it("sums USD-pegged tokens at 1:1", () => {
    const transfers = [
      transfer({ amount: "1000000000000000000" }), // 1 USDm
      transfer({ amount: "2000000000000000000" }), // 2 USDm
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.totalFeesUSD).toBeCloseTo(3, 2);
    expect(result.fees24hUSD).toBe(0); // all old timestamps
  });

  it("handles 6-decimal tokens (USDC)", () => {
    const transfers = [
      transfer({
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        amount: "1500000", // 1.5 USDC
      }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.totalFeesUSD).toBeCloseTo(1.5, 4);
  });

  it("applies FX rates for non-USD tokens", () => {
    const transfers = [
      transfer({
        tokenSymbol: "GBPm",
        tokenDecimals: 18,
        amount: "1000000000000000000", // 1 GBPm
      }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.totalFeesUSD).toBeCloseTo(1.3263, 2); // 1 * 1.3263
  });

  it("splits 24h fees correctly", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({ blockTimestamp: "100" }), // old
      transfer({ blockTimestamp: String(now - 3600) }), // 1h ago (within 24h)
      transfer({ blockTimestamp: String(now - 100) }), // recent
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.totalFeesUSD).toBeCloseTo(3, 2);
    expect(result.fees24hUSD).toBeCloseTo(2, 2); // 2 recent transfers
  });

  it("silently skips UNKNOWN (indexer placeholder) without flagging as unpriced", () => {
    const transfers = [
      transfer({ tokenSymbol: "UNKNOWN", amount: "1000000000000000000" }),
      transfer({ tokenSymbol: "USDm", amount: "1000000000000000000" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.unpricedSymbols).toEqual([]);
    expect(result.totalFeesUSD).toBeCloseTo(1, 2);
  });

  it("reports unpriced symbols when genuinely unknown tokens appear", () => {
    const transfers = [
      transfer({ tokenSymbol: "NEWTOK", amount: "1000000000000000000" }),
      transfer({ tokenSymbol: "USDm", amount: "1000000000000000000" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.unpricedSymbols).toEqual(["NEWTOK"]);
    // Unpriced token excluded from USD total
    expect(result.totalFeesUSD).toBeCloseTo(1, 2);
  });

  it("returns empty unpricedSymbols when all tokens are known", () => {
    const transfers = [
      transfer({ tokenSymbol: "USDm" }),
      transfer({ tokenSymbol: "USDC", tokenDecimals: 6, amount: "1000000" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.unpricedSymbols).toEqual([]);
  });

  it("handles mixed decimals and currencies", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({ tokenSymbol: "USDm", amount: "10000000000000000000" }), // 10 USDm
      transfer({
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        amount: "5000000", // 5 USDC
        blockTimestamp: String(now - 100),
      }),
      transfer({
        tokenSymbol: "GBPm",
        amount: "2000000000000000000", // 2 GBPm = 2.54 USD
      }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.totalFeesUSD).toBeCloseTo(10 + 5 + 2 * 1.3263, 1);
    expect(result.fees24hUSD).toBeCloseTo(5, 2); // only USDC is recent
  });

  it("sets isTruncated=false when below query limit", () => {
    const transfers = [transfer(), transfer()];
    const result = aggregateProtocolFees(transfers);
    expect(result.isTruncated).toBe(false);
  });

  it("sets isTruncated=true when transfers hit the query limit", () => {
    const transfers = Array.from({ length: PROTOCOL_FEE_QUERY_LIMIT }, () =>
      transfer(),
    );
    const result = aggregateProtocolFees(transfers);
    expect(result.isTruncated).toBe(true);
  });

  it("unpricedSymbols24h: includes unpriced symbol in 24h window", () => {
    const now = Math.floor(Date.now() / 1000);
    const transfers = [
      transfer({
        tokenSymbol: "SOMENEWTOK",
        blockTimestamp: String(now - 3600), // 1h ago — within 24h
      }),
      transfer({ tokenSymbol: "USDm" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.unpricedSymbols).toContain("SOMENEWTOK");
    expect(result.unpricedSymbols24h).toContain("SOMENEWTOK");
  });

  it("unpricedSymbols24h: excludes unpriced symbol outside 24h window", () => {
    const transfers = [
      transfer({
        tokenSymbol: "OLDTOK",
        blockTimestamp: "100", // very old — outside 24h
      }),
      transfer({ tokenSymbol: "USDm" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.unpricedSymbols).toContain("OLDTOK");
    expect(result.unpricedSymbols24h).not.toContain("OLDTOK");
    // 24h fees should be exact even though all-time has unpriced symbols
    expect(result.unpricedSymbols24h).toHaveLength(0);
  });

  it("unresolvedCount: counts UNKNOWN transfers without marking them as unpriced", () => {
    const transfers = [
      transfer({ tokenSymbol: "UNKNOWN" }),
      transfer({ tokenSymbol: "UNKNOWN" }),
      transfer({ tokenSymbol: "USDm" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.unresolvedCount).toBe(2);
    expect(result.unpricedSymbols).toHaveLength(0);
    expect(result.totalFeesUSD).toBeCloseTo(1, 2); // only USDm counted
  });
});
