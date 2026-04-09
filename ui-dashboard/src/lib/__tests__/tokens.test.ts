import { describe, it, expect } from "vitest";
import {
  tokenSymbol,
  poolName,
  poolTvlUSD,
  buildOracleRateMap,
} from "../tokens";
import { NETWORKS } from "../networks";

const sepolia = NETWORKS["celo-sepolia-local"];
const mainnet = NETWORKS["celo-mainnet"];
const devnet = NETWORKS.devnet;

// Mainnet token addresses (from @mento-protocol/contracts)
const USDM_MAINNET = "0x765de816845861e75a25fca122bb6898b8b1282a";
const KESM_MAINNET = "0x456a3d042c0dbd3db53d5489e98dfb038553b0d0";

describe("tokenSymbol", () => {
  it("resolves known Sepolia token", () => {
    expect(
      tokenSymbol(sepolia, "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf"),
    ).toBe("KESm");
  });

  it("resolves USDm", () => {
    expect(
      tokenSymbol(sepolia, "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b"),
    ).toBe("USDm");
  });

  it("truncates unknown address", () => {
    const result = tokenSymbol(
      sepolia,
      "0x0000000000000000000000000000000000000001",
    );
    expect(result).toContain("0x0000");
    expect(result).toContain("0001");
  });

  it("returns ? for null", () => {
    expect(tokenSymbol(sepolia, null)).toBe("?");
  });
});

describe("poolName", () => {
  it("puts USDm last", () => {
    expect(
      poolName(
        sepolia,
        "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
        "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
      ),
    ).toBe("KESm/USDm");
  });

  it("keeps order when USDm is token1", () => {
    expect(
      poolName(
        sepolia,
        "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
        "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
      ),
    ).toBe("KESm/USDm");
  });

  it("works for DevNet", () => {
    expect(
      poolName(
        devnet,
        "0xfaea5f3404bba20d3cc2f8c4b0a888f55a3c7313", // GHSm
        "0x765de816845861e75a25fca122bb6898b8b1282a", // USDm
      ),
    ).toBe("GHSm/USDm");
  });
});

describe("poolTvlUSD", () => {
  it("uses token0 as USD leg when token0 is USDm", () => {
    const tvl = poolTvlUSD(
      {
        token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
        token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
        token0Decimals: 18,
        token1Decimals: 18,
        reserves0: "2000000000000000000", // 2 USDm
        reserves1: "3000000000000000000", // 3 KESm
        oraclePrice: "500000000000000000000000", // 0.5
      },
      sepolia,
    );

    // 2 + (3 * 0.5) = 3.5
    expect(tvl).toBeCloseTo(3.5, 8);
  });

  it("uses token1 as USD leg when token1 is USDm", () => {
    const tvl = poolTvlUSD(
      {
        token0: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf", // KESm
        token1: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b", // USDm
        token0Decimals: 18,
        token1Decimals: 18,
        reserves0: "4000000000000000000", // 4 KESm
        reserves1: "1000000000000000000", // 1 USDm
        oraclePrice: "500000000000000000000000", // 0.5
      },
      sepolia,
    );

    // (4 * 0.5) + 1 = 3
    expect(tvl).toBeCloseTo(3, 8);
  });

  it("returns 0 when oracle price is missing", () => {
    const tvl = poolTvlUSD(
      {
        token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
        token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf",
        reserves0: "1000000000000000000",
        reserves1: "1000000000000000000",
      },
      sepolia,
    );

    expect(tvl).toBe(0);
  });

  it("returns 0 when both reserves are missing", () => {
    const tvl = poolTvlUSD(
      {
        token0: "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b",
        token1: "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf",
        oraclePrice: "1000000000000000000000000",
      },
      sepolia,
    );

    expect(tvl).toBe(0);
  });

  it("returns 0 when neither token side is USDm and no rates provided", () => {
    const tvl = poolTvlUSD(
      {
        token0: "0x0000000000000000000000000000000000000003",
        token1: "0x0000000000000000000000000000000000000004",
        token0Decimals: 18,
        token1Decimals: 18,
        reserves0: "2000000000000000000",
        reserves1: "3000000000000000000",
        oraclePrice: "500000000000000000000000",
      },
      sepolia,
    );

    expect(tvl).toBe(0);
  });

  it("uses oracle rate map via sym1 when neither token is USDm", () => {
    // EURm address on mainnet (cEUR)
    const EURM = "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73";
    // axlEUROC address on mainnet
    const AXLEUROC = "0x061cc5a2c863e0c1cb404006d559db18a34c762d";

    const rates = new Map([["EURm", 1.08]]); // 1 EURm ≈ $1.08
    const tvl = poolTvlUSD(
      {
        token0: AXLEUROC,
        token1: EURM,
        token0Decimals: 6,
        token1Decimals: 18,
        reserves0: "2000000", // 2 axlEUROC (6 decimals)
        reserves1: "3000000000000000000", // 3 EURm
        oraclePrice: "500000000000000000000000", // feedVal = 0.5
      },
      mainnet,
      rates,
    );

    // feedVal = 0.5, sym1 (EURm) has rate 1.08
    // TVL = (r0 * feedVal + r1) * usd1 = (2 * 0.5 + 3) * 1.08 = 4.32
    expect(tvl).toBeCloseTo(4.32, 8);
  });

  it("uses oracle rate map via sym0 when sym0 has a known rate", () => {
    const EURM = "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73";
    const AXLEUROC = "0x061cc5a2c863e0c1cb404006d559db18a34c762d";

    // Only axlEUROC has a rate — exercises the sym0 (usd0) branch
    const rates = new Map([["axlEUROC", 1.1]]);
    const tvl = poolTvlUSD(
      {
        token0: AXLEUROC,
        token1: EURM,
        token0Decimals: 6,
        token1Decimals: 18,
        reserves0: "2000000", // 2 axlEUROC
        reserves1: "3000000000000000000", // 3 EURm
        oraclePrice: "500000000000000000000000", // feedVal = 0.5
      },
      mainnet,
      rates,
    );

    // feedVal = 0.5, sym0 (axlEUROC) has rate 1.10
    // TVL = (r0 + r1 * feedVal) * usd0 = (2 + 3 * 0.5) * 1.10 = 3.85
    expect(tvl).toBeCloseTo(3.85, 8);
  });
});

// ---------------------------------------------------------------------------
// buildOracleRateMap
// ---------------------------------------------------------------------------
describe("buildOracleRateMap", () => {
  // 1e24 raw = feedVal 1.0
  const ORACLE_1e24 = "1000000000000000000000000";
  // 0.5e24 = feedVal 0.5
  const ORACLE_HALF = "500000000000000000000000";

  it("extracts rate for token1 when token0 is USDm", () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: ORACLE_HALF,
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.get("KESm")).toBeCloseTo(0.5, 8);
    expect(rates.has("USDm")).toBe(false);
  });

  it("extracts rate for token0 when token1 is USDm", () => {
    const pools = [
      {
        token0: KESM_MAINNET,
        token1: USDM_MAINNET,
        oraclePrice: ORACLE_HALF,
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.get("KESm")).toBeCloseTo(0.5, 8);
  });

  it("skips pool when oracleOk is false", () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: ORACLE_1e24,
        oracleOk: false,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.size).toBe(0);
  });

  it('skips pool when oraclePrice is "0"', () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: "0",
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.size).toBe(0);
  });

  it("skips pool when oraclePrice is missing/falsy", () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: undefined,
        oracleOk: true,
      },
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: "",
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.size).toBe(0);
  });

  it("skips pool when feedVal is non-positive or non-finite", () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: "-1000000000000000000000000",
        oracleOk: true,
      },
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: "not-a-number",
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.size).toBe(0);
  });

  it("neither token rated when both are USDm", () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: USDM_MAINNET,
        oraclePrice: ORACLE_1e24,
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.size).toBe(0);
  });

  it("last pool wins when two pools map the same symbol", () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: ORACLE_HALF,
        oracleOk: true,
      },
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: ORACLE_1e24,
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.get("KESm")).toBeCloseTo(1.0, 8);
  });

  it("skips pool with no USDm leg", () => {
    const pools = [
      {
        token0: KESM_MAINNET,
        token1: "0x0000000000000000000000000000000000000099",
        oraclePrice: ORACLE_1e24,
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.size).toBe(0);
  });

  it("populates legacy cEUR alias when EURm has a rate", () => {
    const EURM_MAINNET = "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73";
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: EURM_MAINNET,
        oraclePrice: ORACLE_HALF,
        oracleOk: true,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    expect(rates.get("EURm")).toBeCloseTo(0.5, 8);
    expect(rates.get("cEUR")).toBeCloseTo(0.5, 8);
  });

  it("includes pool when oracleOk is undefined (documents current behavior)", () => {
    const pools = [
      {
        token0: USDM_MAINNET,
        token1: KESM_MAINNET,
        oraclePrice: ORACLE_1e24,
        oracleOk: undefined,
      },
    ];
    const rates = buildOracleRateMap(pools, mainnet);
    // oracleOk === undefined does NOT trigger the `=== false` guard,
    // so the pool IS included.
    expect(rates.get("KESm")).toBeCloseTo(1.0, 8);
  });
});
