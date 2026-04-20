import { describe, it, expect } from "vitest";
import {
  transferAmountTokens,
  transferAmountUsd,
  usdPricedFromLiveRate,
} from "../pricing";
import type { OracleRateMap } from "@/lib/tokens";
import { makeTransfer as mk } from "./fixtures";

describe("transferAmountTokens", () => {
  it("returns null when amount is null", () => {
    expect(transferAmountTokens(mk({ amount: null }))).toBeNull();
  });

  it("parses wei by tokenDecimals", () => {
    const t = mk({ amount: "1000000000000000000", tokenDecimals: 18 });
    expect(transferAmountTokens(t)).toBe(1);
  });
});

describe("transferAmountUsd", () => {
  const rates: OracleRateMap = new Map([["GBPm", 1.32]]);

  it("prefers indexer-pinned usdValueAtSend when finite", () => {
    const t = mk({
      amount: "1000000000000000000",
      tokenDecimals: 18,
      tokenSymbol: "GBPm",
      usdValueAtSend: "9999.00",
    });
    expect(transferAmountUsd(t, rates)).toBe(9999);
  });

  it("falls back to live rate when usdValueAtSend is null", () => {
    const t = mk({
      amount: "100000000000000000000",
      tokenDecimals: 18,
      tokenSymbol: "GBPm",
    });
    expect(transferAmountUsd(t, rates)).toBeCloseTo(132);
  });

  it("falls back to live rate when usdValueAtSend is a non-finite string", () => {
    const t = mk({
      amount: "100000000000000000000",
      tokenDecimals: 18,
      tokenSymbol: "GBPm",
      usdValueAtSend: "not-a-number",
    });
    expect(transferAmountUsd(t, rates)).toBeCloseTo(132);
  });

  it("returns null when amount is null and no pinned value", () => {
    expect(transferAmountUsd(mk({ amount: null }), rates)).toBeNull();
  });

  it("returns null for unknown token when no pinned value", () => {
    const t = mk({
      amount: "1000000000000000000",
      tokenDecimals: 18,
      tokenSymbol: "UNKNOWN",
    });
    expect(transferAmountUsd(t, rates)).toBeNull();
  });

  it("treats USDm as 1:1 USD without needing a rate", () => {
    const t = mk({
      amount: "5000000000000000000",
      tokenDecimals: 18,
      tokenSymbol: "USDm",
    });
    expect(transferAmountUsd(t, new Map())).toBe(5);
  });
});

describe("usdPricedFromLiveRate", () => {
  it("true when usdValueAtSend is null — live rate was used", () => {
    expect(usdPricedFromLiveRate(mk({ usdValueAtSend: null }))).toBe(true);
  });

  it("false when usdValueAtSend is populated — indexer-pinned", () => {
    expect(usdPricedFromLiveRate(mk({ usdValueAtSend: "42.00" }))).toBe(false);
  });

  it("true when usdValueAtSend is the legacy '0.00' sentinel", () => {
    // Must match transferAmountUsd's `n > 0` guard — otherwise a "0.00" row
    // would price via live rate but render without the `~` prefix.
    expect(usdPricedFromLiveRate(mk({ usdValueAtSend: "0.00" }))).toBe(true);
  });

  it("true when usdValueAtSend is non-numeric", () => {
    expect(usdPricedFromLiveRate(mk({ usdValueAtSend: "garbage" }))).toBe(true);
  });
});
