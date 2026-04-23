import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test. Factories run
// hoisted so we resolve the mocks afterwards via `vi.mocked` — the `const`
// variables referenced below live inside `vi.hoisted` so they exist when
// the factories execute.
const { mockDetectStrategyType, mockGetViemClient } = vi.hoisted(() => ({
  mockDetectStrategyType: vi.fn(),
  mockGetViemClient: vi.fn(),
}));

vi.mock("@/lib/rebalance-check", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rebalance-check")>(
    "@/lib/rebalance-check",
  );
  return { ...actual, detectStrategyType: mockDetectStrategyType };
});

vi.mock("@/lib/rpc-client", () => ({
  getViemClient: mockGetViemClient,
  ERC20_ABI: [],
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

import {
  detectCdpPoolIds,
  clearStrategyTypeCache,
} from "@/lib/strategy-detection";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

const NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://hasura.example/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  testnet: false,
  hasVirtualPools: false,
  rpcUrl: "https://rpc.example.com",
};

function makePool(poolAddress: string, rebalancer: string): Pool {
  return {
    id: `${NETWORK.chainId}-${poolAddress}`,
    chainId: NETWORK.chainId,
    token0: null,
    token1: null,
    source: "FPMM",
    createdAtBlock: "0",
    createdAtTimestamp: "0",
    updatedAtBlock: "0",
    updatedAtTimestamp: "0",
    rebalancerAddress: rebalancer,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearStrategyTypeCache();
  mockGetViemClient.mockReturnValue({});
});

describe("detectCdpPoolIds", () => {
  it("returns an empty set when the network has no rpcUrl", async () => {
    const result = await detectCdpPoolIds({ ...NETWORK, rpcUrl: undefined }, [
      makePool("0xpool1", "0xreb1"),
    ]);

    expect(result).toEqual(new Set());
    expect(mockGetViemClient).not.toHaveBeenCalled();
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("skips pools without a rebalancer address", async () => {
    const result = await detectCdpPoolIds(NETWORK, [
      makePool("0xpool1", ""),
      { ...makePool("0xpool2", ""), rebalancerAddress: undefined },
    ]);

    expect(result).toEqual(new Set());
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("flags pools whose rebalancer probes as cdp", async () => {
    mockDetectStrategyType
      .mockResolvedValueOnce("cdp")
      .mockResolvedValueOnce("reserve");

    const result = await detectCdpPoolIds(NETWORK, [
      makePool("0xpool1", "0xcdpreb"),
      makePool("0xpool2", "0xreserveb"),
    ]);

    expect(result).toEqual(new Set([`${NETWORK.chainId}-0xpool1`]));
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(2);
  });

  it("probes each unique rebalancer once even when many pools share it", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    const result = await detectCdpPoolIds(NETWORK, [
      makePool("0xpool1", "0xshared"),
      makePool("0xpool2", "0xshared"),
      makePool("0xpool3", "0xshared"),
    ]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(3);
  });

  it("lowercases the rebalancer address when keying the cache", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectCdpPoolIds(NETWORK, [
      makePool("0xpool1", "0xABCDEF"),
      makePool("0xpool2", "0xabcdef"),
    ]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
  });

  it("reuses cached results across calls within the TTL", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectCdpPoolIds(NETWORK, [makePool("0xpool1", "0xreb")]);
    await detectCdpPoolIds(NETWORK, [makePool("0xpool2", "0xreb")]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
  });

  it("fails open (empty set, no throw) when an individual probe rejects", async () => {
    mockDetectStrategyType.mockRejectedValueOnce(new Error("rpc down"));

    const result = await detectCdpPoolIds(NETWORK, [
      makePool("0xpool1", "0xreb"),
    ]);

    expect(result).toEqual(new Set());
  });

  it("does not flag reserve or ols pools as cdp", async () => {
    mockDetectStrategyType
      .mockResolvedValueOnce("reserve")
      .mockResolvedValueOnce("ols")
      .mockResolvedValueOnce("unknown");

    const result = await detectCdpPoolIds(NETWORK, [
      makePool("0xpool1", "0xreb1"),
      makePool("0xpool2", "0xreb2"),
      makePool("0xpool3", "0xreb3"),
    ]);

    expect(result).toEqual(new Set());
  });
});
