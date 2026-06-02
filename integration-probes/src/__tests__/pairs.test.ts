import { describe, expect, it } from "vitest";
import { contractEntries } from "@mento-protocol/monitoring-config/tokens";
import { buildQuoteInputs, hubPairsFromPoolRows } from "../pairs.js";

const USDM = tokenAddress("USDm");
const EURM = tokenAddress("EURm");
const POOL = "42220-0x3333333333333333333333333333333333333333";

describe("hubPairsFromPoolRows", () => {
  it("derives active USDm hub pairs from non-zero reserve pools", () => {
    const pairs = hubPairsFromPoolRows(42220, [
      {
        id: POOL,
        chainId: 42220,
        token0: EURM,
        token1: USDM,
        token0Decimals: 18,
        token1Decimals: 18,
        source: "fpmm_factory",
        reserves0: "1",
        reserves1: "1",
      },
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.base.symbol).toBe("EURm");
    expect(pairs[0]?.quote.symbol).toBe("USDm");
    expect(pairs[0]?.poolAddress).toBe(
      "0x3333333333333333333333333333333333333333",
    );
  });

  it("omits drained and non-USDm pools", () => {
    const pairs = hubPairsFromPoolRows(42220, [
      {
        id: POOL,
        chainId: 42220,
        token0: EURM,
        token1: USDM,
        token0Decimals: 18,
        token1Decimals: 18,
        source: "fpmm_factory",
        reserves0: "0",
        reserves1: "1",
      },
    ]);

    expect(pairs).toEqual([]);
  });
});

describe("buildQuoteInputs", () => {
  it("creates both USDm hub directions", () => {
    const pairs = hubPairsFromPoolRows(42220, [
      {
        id: POOL,
        chainId: 42220,
        token0: EURM,
        token1: USDM,
        token0Decimals: 18,
        token1Decimals: 18,
        source: "fpmm_factory",
        reserves0: "1",
        reserves1: "1",
      },
    ]);
    const inputs = buildQuoteInputs({
      chain: {
        chainId: 42220,
        chainLabel: "Celo",
        chainSlug: "celo",
        routerAddresses: [],
        poolAddresses: [],
        pairs,
      },
      amountUsd: "1",
      takerAddress: "0x000000000000000000000000000000000000dEaD",
    });

    expect(inputs.map((input) => input.direction)).toEqual([
      "base-to-usdm",
      "usdm-to-base",
    ]);
    expect(inputs[0]?.amountRaw).toBe("1000000000000000000");
  });
});

function tokenAddress(symbol: string): string {
  const entry = contractEntries(42220).find(
    (candidate) =>
      candidate.type === "token" && candidate.canonicalName === symbol,
  );
  if (!entry) throw new Error(`Missing ${symbol} test token`);
  return entry.address;
}
