import { describe, expect, it } from "vitest";
import { contractEntries } from "@mento-protocol/config/tokens";
import { buildQuoteInputs, hubPairsFromPoolRows } from "../pairs.js";
import { PROBE_CHAIN_IDS } from "../types.js";

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
    expect(pairs[0]?.baseReserveRaw).toBe("1");
    expect(pairs[0]?.quoteReserveRaw).toBe("1");
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

  it("discovers only Polygon's active USDm hub pools", () => {
    const usdc = tokenAddressFor(137, "USDC");
    const usdm = tokenAddressFor(137, "USDm");
    const eurm = tokenAddressFor(137, "EURm");
    const europ = tokenAddressFor(137, "EUROP");
    const pairs = hubPairsFromPoolRows(137, [
      polygonPoolRow(
        "137-0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5",
        usdc,
        usdm,
        6,
        18,
      ),
      polygonPoolRow(
        "137-0x93e15a22fda39fefccce82d387a09ccf030ead61",
        eurm,
        usdm,
        18,
        18,
      ),
      polygonPoolRow(
        "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
        eurm,
        europ,
        18,
        6,
      ),
    ]);

    expect(pairs.map((pair) => pair.base.symbol)).toEqual(["EURm", "USDC"]);
    expect(pairs.every((pair) => pair.quote.symbol === "USDm")).toBe(true);
    expect(pairs.map((pair) => pair.poolAddress)).toEqual([
      "0x93e15a22fda39fefccce82d387a09ccf030ead61",
      "0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5",
    ]);
  });
});

describe("probe chain fleet", () => {
  it("includes Polygon mainnet", () => {
    expect(PROBE_CHAIN_IDS).toEqual([42220, 143, 137]);
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
    expect(inputs[0]?.sellReserveRaw).toBe("1");
    expect(inputs[0]?.buyReserveRaw).toBe("1");
    expect(inputs[1]?.sellReserveRaw).toBe("1");
    expect(inputs[1]?.buyReserveRaw).toBe("1");
  });
});

function tokenAddress(symbol: string): string {
  return tokenAddressFor(42220, symbol);
}

function tokenAddressFor(chainId: number, symbol: string): string {
  const entry = contractEntries(chainId).find(
    (candidate) =>
      candidate.type === "token" && candidate.canonicalName === symbol,
  );
  if (!entry) throw new Error(`Missing ${symbol} test token on ${chainId}`);
  return entry.address;
}

function polygonPoolRow(
  id: string,
  token0: string,
  token1: string,
  token0Decimals: number,
  token1Decimals: number,
) {
  return {
    id,
    chainId: 137,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    source: "fpmm_factory",
    reserves0: "1",
    reserves1: "1",
  };
}
