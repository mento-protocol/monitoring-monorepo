import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the module under test. Factories run
// hoisted, so the `const` refs they close over must live inside
// `vi.hoisted` to exist at factory-run time.
const { mockDetectStrategyType, mockGetViemClient, mockCaptureException } =
  vi.hoisted(() => ({
    mockDetectStrategyType: vi.fn(),
    mockGetViemClient: vi.fn(),
    mockCaptureException: vi.fn(),
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
  captureException: mockCaptureException,
}));

import {
  detectCdpPoolIds,
  clearStrategyTypeCache,
} from "@/lib/strategy-detection";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";

// Valid-checksum-less addresses so `isAddress` accepts them. Using distinct
// low hex strings keeps the fixtures readable while still passing viem's
// length/charset checks.
const POOL_A = "0x000000000000000000000000000000000000aaaa";
const POOL_B = "0x000000000000000000000000000000000000bbbb";
const POOL_C = "0x000000000000000000000000000000000000cccc";
const REB_CDP = "0x000000000000000000000000000000000000c0c0";
const REB_RESERVE = "0x000000000000000000000000000000000000d0d0";
const REB_OLS = "0x000000000000000000000000000000000000e0e0";
const REB_SHARED = "0x000000000000000000000000000000000000f0f0";

const CELO: Network = {
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

const MONAD: Network = {
  ...CELO,
  id: "monad-mainnet",
  label: "Monad",
  chainId: 143,
  hasuraUrl: "https://hasura-monad.example/v1/graphql",
};

function makePool(
  poolAddress: string,
  rebalancer: string | undefined,
  chainId: number = CELO.chainId,
): Pool {
  return {
    id: `${chainId}-${poolAddress}`,
    chainId,
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

afterEach(() => {
  vi.useRealTimers();
});

describe("detectCdpPoolIds", () => {
  it("returns an empty set when the network has no rpcUrl", async () => {
    const result = await detectCdpPoolIds({ ...CELO, rpcUrl: undefined }, [
      makePool(POOL_A, REB_CDP),
    ]);

    expect(result).toEqual(new Set());
    expect(mockGetViemClient).not.toHaveBeenCalled();
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("skips pools without a rebalancer address", async () => {
    const result = await detectCdpPoolIds(CELO, [
      makePool(POOL_A, ""),
      makePool(POOL_B, undefined),
    ]);

    expect(result).toEqual(new Set());
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("skips pools whose rebalancer fails viem's isAddress check", async () => {
    const result = await detectCdpPoolIds(CELO, [
      makePool(POOL_A, "not-hex"),
      makePool(POOL_B, "0xabc"),
    ]);

    expect(result).toEqual(new Set());
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("flags pools whose rebalancer probes as cdp", async () => {
    mockDetectStrategyType
      .mockResolvedValueOnce("cdp")
      .mockResolvedValueOnce("reserve");

    const result = await detectCdpPoolIds(CELO, [
      makePool(POOL_A, REB_CDP),
      makePool(POOL_B, REB_RESERVE),
    ]);

    expect(result).toEqual(new Set([`${CELO.chainId}-${POOL_A}`]));
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(2);
  });

  it("probes each unique rebalancer once even when many pools share it", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    const result = await detectCdpPoolIds(CELO, [
      makePool(POOL_A, REB_SHARED),
      makePool(POOL_B, REB_SHARED),
      makePool(POOL_C, REB_SHARED),
    ]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(3);
  });

  it("keys the cache by lowercased rebalancer across separate calls", async () => {
    // First call with mixed-case address populates the cache.
    mockDetectStrategyType.mockResolvedValueOnce("cdp");
    await detectCdpPoolIds(CELO, [
      makePool(POOL_A, REB_CDP.toUpperCase().replace("0X", "0x")),
    ]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);

    // Second call with the canonical-lowercase form must hit the cache.
    // If `cacheKey` kept raw casing, this would re-probe.
    const result = await detectCdpPoolIds(CELO, [makePool(POOL_B, REB_CDP)]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
    expect(result).toEqual(new Set([`${CELO.chainId}-${POOL_B}`]));
  });

  it("reuses cached results across calls within the TTL", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectCdpPoolIds(CELO, [makePool(POOL_A, REB_CDP)]);
    await detectCdpPoolIds(CELO, [makePool(POOL_B, REB_CDP)]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the cache TTL expires", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T00:00:00Z");
    vi.setSystemTime(now);

    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectCdpPoolIds(CELO, [makePool(POOL_A, REB_CDP)]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);

    // Advance past the 1-hour TTL.
    vi.setSystemTime(new Date(now.getTime() + 61 * 60 * 1000));

    await detectCdpPoolIds(CELO, [makePool(POOL_B, REB_CDP)]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(2);
  });

  it("keeps cache entries per-chain so the same rebalancer on two chains probes twice", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectCdpPoolIds(CELO, [makePool(POOL_A, REB_SHARED)]);
    await detectCdpPoolIds(MONAD, [
      makePool(POOL_B, REB_SHARED, MONAD.chainId),
    ]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(2);
  });

  it("fails open and reports the error to Sentry when an individual probe rejects", async () => {
    const rpcErr = new Error("rpc down");
    mockDetectStrategyType.mockRejectedValueOnce(rpcErr);

    const result = await detectCdpPoolIds(CELO, [makePool(POOL_A, REB_CDP)]);

    expect(result).toEqual(new Set());
    expect(mockCaptureException).toHaveBeenCalledWith(
      rpcErr,
      expect.objectContaining({
        tags: expect.objectContaining({
          source: "strategy-detection",
          network: CELO.id,
          rebalancer: REB_CDP.toLowerCase(),
        }),
      }),
    );
  });

  it("returns successful CDP flags even when another rebalancer in the same batch fails", async () => {
    mockDetectStrategyType.mockImplementation(
      async (_client, strategy: `0x${string}`) => {
        if (strategy.toLowerCase() === REB_RESERVE) throw new Error("rpc down");
        return "cdp";
      },
    );

    const result = await detectCdpPoolIds(CELO, [
      makePool(POOL_A, REB_CDP),
      makePool(POOL_B, REB_RESERVE),
    ]);

    expect(result).toEqual(new Set([`${CELO.chainId}-${POOL_A}`]));
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("does not flag reserve or ols pools as cdp", async () => {
    mockDetectStrategyType
      .mockResolvedValueOnce("reserve")
      .mockResolvedValueOnce("ols")
      .mockResolvedValueOnce("unknown");

    const result = await detectCdpPoolIds(CELO, [
      makePool(POOL_A, REB_CDP),
      makePool(POOL_B, REB_RESERVE),
      makePool(POOL_C, REB_OLS),
    ]);

    expect(result).toEqual(new Set());
  });

  it("times out a slow probe rather than blowing the outer request budget", async () => {
    vi.useFakeTimers();
    // A probe that never resolves on its own — only the internal 3s timeout
    // should terminate it.
    mockDetectStrategyType.mockImplementation(() => new Promise(() => {}));

    const pending = detectCdpPoolIds(CELO, [makePool(POOL_A, REB_CDP)]);
    await vi.advanceTimersByTimeAsync(3500);
    const result = await pending;

    expect(result).toEqual(new Set());
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("timed out"),
      }),
      expect.anything(),
    );
  });
});
