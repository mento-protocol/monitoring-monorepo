import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, toBytes } from "viem";

// Mock viem before importing the module under test
const mockCall = vi.fn();
const mockReadContract = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    createPublicClient: () => ({
      call: mockCall,
      readContract: mockReadContract,
    }),
  };
});

import { checkRebalanceStatus } from "../rebalance-check";

const POOL = "0x1111111111111111111111111111111111111111";
const STRATEGY = "0x2222222222222222222222222222222222222222";
const RPC_URL = "https://forno.celo.org";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("checkRebalanceStatus", () => {
  it("returns canRebalance=true when simulation succeeds", async () => {
    // Strategy type detection: getCDPConfig reverts, reserve() succeeds
    mockReadContract
      .mockRejectedValueOnce(new Error("not CDP"))
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333");
    // Simulate rebalance succeeds
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(true);
    expect(result.message).toBe("Rebalance is currently possible");
    expect(result.rawError).toBeNull();
    expect(result.strategyType).toBe("reserve");
  });

  it("returns canRebalance=false with human message on known revert", async () => {
    // Strategy type detection: getCDPConfig succeeds (CDP strategy)
    mockReadContract.mockResolvedValueOnce({
      stabilityPool: "0x4444444444444444444444444444444444444444",
      collateralRegistry: "0x5555555555555555555555555555555555555555",
      stabilityPoolPercentage: BigInt(100),
      maxIterations: BigInt(10),
    });

    // Use real ABI-encoded selector for CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()
    // Error selectors are keccak256 of the bare signature, first 4 bytes
    const CDPLS_SELECTOR = keccak256(
      toBytes("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()"),
    ).slice(0, 10) as `0x${string}`;

    // Simulate rebalance reverts with real selector
    const err = new Error("execution reverted");
    Object.assign(err, {
      data: CDPLS_SELECTOR,
    });
    mockCall.mockRejectedValueOnce(err);

    // For enrichment: getCDPConfig + getTotalBoldDeposits + boldToken + symbol + decimals
    mockReadContract
      .mockResolvedValueOnce({
        stabilityPool: "0x4444444444444444444444444444444444444444",
        collateralRegistry: "0x5555555555555555555555555555555555555555",
        stabilityPoolPercentage: BigInt(100),
        maxIterations: BigInt(10),
      })
      .mockResolvedValueOnce(BigInt(0)) // getTotalBoldDeposits
      .mockResolvedValueOnce("0x6666666666666666666666666666666666666666") // boldToken
      .mockResolvedValueOnce("USDm") // symbol
      .mockResolvedValueOnce(18); // decimals

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.strategyType).toBe("cdp");
    expect(result.rawError).toBe("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW");
    expect(result.message).toContain("Stability pool");
    expect(result.enrichment).toEqual({
      type: "cdp",
      stabilityPoolBalance: 0,
      stabilityPoolTokenSymbol: "USDm",
      stabilityPoolTokenDecimals: 18,
    });
  });

  it("detects CDP strategy type when getCDPConfig succeeds", async () => {
    mockReadContract.mockResolvedValueOnce({
      stabilityPool: "0x4444444444444444444444444444444444444444",
      collateralRegistry: "0x5555555555555555555555555555555555555555",
      stabilityPoolPercentage: BigInt(100),
      maxIterations: BigInt(10),
    });
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);
    expect(result.strategyType).toBe("cdp");
  });

  it("detects reserve strategy type when getCDPConfig fails but reserve() succeeds", async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("no getCDPConfig"))
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333");
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);
    expect(result.strategyType).toBe("reserve");
  });

  it('detects "unknown" strategy type when both probes fail', async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("no getCDPConfig"))
      .mockRejectedValueOnce(new Error("no reserve"));
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);
    expect(result.strategyType).toBe("unknown");
  });

  it("handles revert with no parseable data gracefully", async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("no getCDPConfig"))
      .mockRejectedValueOnce(new Error("no reserve"));

    const err = new Error("execution reverted");
    mockCall.mockRejectedValueOnce(err);

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.message).toBe("Rebalance reverted with an unknown error");
    expect(result.strategyType).toBe("unknown");
  });
});
