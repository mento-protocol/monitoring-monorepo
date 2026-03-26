import { describe, expect, it } from "vitest";
import {
  classifySwap,
  isTradeSwap,
  ROUTER_ADDRESSES,
  STRATEGY_ADDRESSES,
} from "../mento-addresses";

// Chain IDs (canonical, from networks.ts):
//   Celo Mainnet   = 42220
//   Celo Sepolia   = 11142220
//   Monad Mainnet  = 143
//   Monad Testnet  = 10143

// ---------------------------------------------------------------------------
// Address format validation — catches typos in the address maps at test time
// ---------------------------------------------------------------------------
const EVM_ADDR_RE = /^0x[0-9a-f]{40}$/;

describe("Address map format validation", () => {
  it("all ROUTER_ADDRESSES are valid 42-char lowercase EVM addresses", () => {
    for (const [chainId, addrs] of Object.entries(ROUTER_ADDRESSES)) {
      for (const addr of addrs) {
        expect(
          addr,
          `ROUTER_ADDRESSES[${chainId}] has invalid address: ${addr}`,
        ).toMatch(EVM_ADDR_RE);
      }
    }
  });

  it("all STRATEGY_ADDRESSES are valid 42-char lowercase EVM addresses", () => {
    for (const [chainId, addrs] of Object.entries(STRATEGY_ADDRESSES)) {
      for (const addr of addrs) {
        expect(
          addr,
          `STRATEGY_ADDRESSES[${chainId}] has invalid address: ${addr}`,
        ).toMatch(EVM_ADDR_RE);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// classifySwap — uses independent literals, NOT the constants under test.
// Literals are sourced from @mento-protocol/contracts.
// ---------------------------------------------------------------------------
describe("classifySwap", () => {
  describe("Router addresses → 'trade'", () => {
    it("Celo Mainnet (42220) Router", () => {
      expect(
        classifySwap("0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", 42220),
      ).toBe("trade");
    });

    it("Celo Sepolia (11142220) Router", () => {
      expect(
        classifySwap("0xcf6cd45210b3ffe3ca28379c4683f1e60d0c2ccd", 11142220),
      ).toBe("trade");
    });

    it("Celo Sepolia (11142220) MentoRouter", () => {
      expect(
        classifySwap("0x8e4fb12d86d5df911086a9153e79ca27e0c96156", 11142220),
      ).toBe("trade");
    });

    it("Monad Mainnet (143) Routerv300", () => {
      expect(
        classifySwap("0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", 143),
      ).toBe("trade");
    });

    it("Monad Testnet (10143) Routerv300", () => {
      expect(
        classifySwap("0xcf6cd45210b3ffe3ca28379c4683f1e60d0c2ccd", 10143),
      ).toBe("trade");
    });
  });

  describe("Strategy addresses → 'lp_swap'", () => {
    it("Celo Mainnet (42220) ReserveLiquidityStrategy", () => {
      expect(
        classifySwap("0xa0fb8b16ce6af3634ff9f3f4f40e49e1c1ae4f0b", 42220),
      ).toBe("lp_swap");
    });

    it("Celo Mainnet (42220) CDPLiquidityStrategy", () => {
      expect(
        classifySwap("0x4e78bd9565341eabe99cdc024acb044d9bdcb985", 42220),
      ).toBe("lp_swap");
    });

    it("Celo Sepolia (11142220) ReserveLiquidityStrategy", () => {
      expect(
        classifySwap("0x734bb3251ec3f1a83f8f2a8609bcef649d54ebf8", 11142220),
      ).toBe("lp_swap");
    });

    it("Celo Sepolia (11142220) CDPLiquidityStrategy", () => {
      expect(
        classifySwap("0x065ae7d4e207c8f4dca112d0b79e668cc7e93e03", 11142220),
      ).toBe("lp_swap");
    });

    it("Monad Mainnet (143) OpenLiquidityStrategy", () => {
      expect(
        classifySwap("0x54e2ae8c8448912e17ce0b2453bafb7b0d80e40f", 143),
      ).toBe("lp_swap");
    });

    it("Monad Testnet (10143) OpenLiquidityStrategy", () => {
      expect(
        classifySwap("0xccd2ad0603a08ebc14d223a983171ef18192e8c9", 10143),
      ).toBe("lp_swap");
    });
  });

  describe("Unknown address → 'direct'", () => {
    it("random EOA returns 'direct'", () => {
      expect(
        classifySwap("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", 42220),
      ).toBe("direct");
    });

    it("unknown chainId returns 'direct'", () => {
      expect(
        classifySwap("0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", 1),
      ).toBe("direct");
    });
  });

  describe("Case-insensitive matching", () => {
    it("uppercase Celo Mainnet router still returns 'trade'", () => {
      expect(
        classifySwap("0x4861840C2EFB2B98312B0AE34D86FD73E8F9B6F6", 42220),
      ).toBe("trade");
    });

    it("uppercase Celo Mainnet strategy still returns 'lp_swap'", () => {
      expect(
        classifySwap("0xA0FB8B16CE6AF3634FF9F3F4F40E49E1C1AE4F0B", 42220),
      ).toBe("lp_swap");
    });
  });

  describe("Cross-chain isolation", () => {
    it("Celo Mainnet router on Monad Testnet chain returns 'direct'", () => {
      // 0x4861840... is a router on Celo mainnet (42220) and Monad mainnet (143),
      // but NOT on Monad testnet (10143).
      expect(
        classifySwap("0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", 10143),
      ).toBe("direct");
    });

    it("Celo Mainnet strategy on Celo Sepolia chain returns 'direct'", () => {
      // CDPLiquidityStrategy on Celo Mainnet has a different address on Celo Sepolia
      expect(
        classifySwap("0x4e78bd9565341eabe99cdc024acb044d9bdcb985", 11142220),
      ).toBe("direct");
    });
  });
});

describe("isTradeSwap", () => {
  it("returns true for 'trade'", () => {
    expect(isTradeSwap("trade")).toBe(true);
  });

  it("returns true for 'direct'", () => {
    expect(isTradeSwap("direct")).toBe(true);
  });

  it("returns false for 'lp_swap'", () => {
    expect(isTradeSwap("lp_swap")).toBe(false);
  });
});
