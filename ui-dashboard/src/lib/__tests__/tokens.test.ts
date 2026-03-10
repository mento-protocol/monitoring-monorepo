import { describe, it, expect } from "vitest";
import { tokenSymbol, poolName, poolTvlUSD } from "../tokens";
import { NETWORKS } from "../networks";

const sepolia = NETWORKS["celo-sepolia-local"];
const devnet = NETWORKS.devnet;

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

  it("returns 0 when neither token side is USDm", () => {
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
});
