import { describe, it, expect } from "vitest";
import { tokenSymbol, poolName } from "../tokens";
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
