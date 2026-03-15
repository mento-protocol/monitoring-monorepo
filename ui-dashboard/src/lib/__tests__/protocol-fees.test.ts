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
    expect(tokenToUSD("GBPm", 100)).toBeCloseTo(127, 2);
  });

  it("converts cEUR at FX rate", () => {
    expect(tokenToUSD("cEUR", 100)).toBeCloseTo(108, 2);
  });

  it("converts AUSD at 1:1", () => {
    expect(tokenToUSD("AUSD", 100)).toBe(100);
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
    expect(result.hasUnknownTokens).toBe(false);
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
    expect(result.totalFeesUSD).toBeCloseTo(1.27, 2); // 1 * 1.27
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

  it("sets hasUnknownTokens when unknown symbols present", () => {
    const transfers = [
      transfer({ tokenSymbol: "UNKNOWN", amount: "1000000000000000000" }),
      transfer({ tokenSymbol: "USDm", amount: "1000000000000000000" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.hasUnknownTokens).toBe(true);
    // Unknown token should be excluded from USD total
    expect(result.totalFeesUSD).toBeCloseTo(1, 2);
  });

  it("does not set hasUnknownTokens when all tokens are known", () => {
    const transfers = [
      transfer({ tokenSymbol: "USDm" }),
      transfer({ tokenSymbol: "USDC", tokenDecimals: 6, amount: "1000000" }),
    ];
    const result = aggregateProtocolFees(transfers);
    expect(result.hasUnknownTokens).toBe(false);
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
    expect(result.totalFeesUSD).toBeCloseTo(10 + 5 + 2.54, 1);
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
});
