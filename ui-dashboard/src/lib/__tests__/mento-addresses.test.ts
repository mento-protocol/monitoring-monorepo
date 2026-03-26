import { describe, expect, it } from "vitest";
import {
  classifySwap,
  isTradeSwap,
  ROUTER_ADDRESSES,
  STRATEGY_ADDRESSES,
} from "../mento-addresses";

describe("classifySwap", () => {
  describe("Router addresses → 'trade'", () => {
    it("Celo mainnet (42220) router", () => {
      expect(
        classifySwap("0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", 42220),
      ).toBe("trade");
    });

    it("Celo Sepolia (143) router", () => {
      expect(
        classifySwap("0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", 143),
      ).toBe("trade");
    });

    it("Monad testnet (10143) router", () => {
      expect(
        classifySwap("0xcf6cd45210b3ffe3ca28379c4683f1e60d0c2ccd", 10143),
      ).toBe("trade");
    });

    it("Monad mainnet (11142220) router", () => {
      expect(
        classifySwap("0xcf6cd45210b3ffe3ca28379c4683f1e60d0c2ccd", 11142220),
      ).toBe("trade");
    });
  });

  describe("Strategy addresses → 'lp_swap'", () => {
    it("Celo mainnet (42220) strategy", () => {
      const [addr] = STRATEGY_ADDRESSES[42220]!;
      expect(classifySwap(addr, 42220)).toBe("lp_swap");
    });

    it("Celo Sepolia (143) strategy", () => {
      const [addr] = STRATEGY_ADDRESSES[143]!;
      expect(classifySwap(addr, 143)).toBe("lp_swap");
    });

    it("Monad testnet (10143) strategy", () => {
      const [addr] = STRATEGY_ADDRESSES[10143]!;
      expect(classifySwap(addr, 10143)).toBe("lp_swap");
    });

    it("Monad mainnet (11142220) strategy", () => {
      const [addr] = STRATEGY_ADDRESSES[11142220]!;
      expect(classifySwap(addr, 11142220)).toBe("lp_swap");
    });
  });

  describe("Unknown address → 'direct'", () => {
    it("random EOA returns direct", () => {
      expect(
        classifySwap("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", 42220),
      ).toBe("direct");
    });

    it("unknown chainId returns direct", () => {
      expect(
        classifySwap("0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", 1),
      ).toBe("direct");
    });
  });

  describe("Case-insensitive matching", () => {
    it("uppercase router address still returns 'trade'", () => {
      expect(
        classifySwap("0x4861840C2EFB2B98312B0AE34D86FD73E8F9B6F6", 42220),
      ).toBe("trade");
    });

    it("mixed-case strategy address still returns 'lp_swap'", () => {
      const [addr] = STRATEGY_ADDRESSES[42220]!;
      expect(classifySwap(addr.toUpperCase(), 42220)).toBe("lp_swap");
    });
  });

  describe("Router address on wrong chain returns 'direct'", () => {
    it("Celo mainnet router on Monad testnet chain", () => {
      const celoRouter = [...ROUTER_ADDRESSES[42220]!][0]!;
      expect(classifySwap(celoRouter, 10143)).toBe("direct");
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
