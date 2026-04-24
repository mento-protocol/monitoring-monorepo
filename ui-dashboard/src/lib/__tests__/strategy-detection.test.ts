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
  detectProbedStrategies,
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

// Same chainId as CELO, different `id` + `rpcUrl` — exercises the
// networkId-scoped cache key that prevents cross-deployment leakage when
// two configured networks share a chainId.
const CELO_DEVNET: Network = {
  ...CELO,
  id: "devnet",
  label: "Celo Devnet (local)",
  local: true,
  rpcUrl: "http://localhost:8545",
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

describe("detectProbedStrategies", () => {
  it("returns empty sets when the network has no rpcUrl", async () => {
    const result = await detectProbedStrategies(
      { ...CELO, rpcUrl: undefined },
      [makePool(POOL_A, REB_CDP)],
    );

    expect(result).toEqual({
      cdpPoolIds: new Set(),
      reservePoolIds: new Set(),
    });
    expect(mockGetViemClient).not.toHaveBeenCalled();
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("skips pools without a rebalancer address", async () => {
    const result = await detectProbedStrategies(CELO, [
      makePool(POOL_A, ""),
      makePool(POOL_B, undefined),
    ]);

    expect(result).toEqual({
      cdpPoolIds: new Set(),
      reservePoolIds: new Set(),
    });
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("skips pools whose rebalancer fails viem's isAddress check", async () => {
    const result = await detectProbedStrategies(CELO, [
      makePool(POOL_A, "not-hex"),
      makePool(POOL_B, "0xabc"),
    ]);

    expect(result).toEqual({
      cdpPoolIds: new Set(),
      reservePoolIds: new Set(),
    });
    expect(mockDetectStrategyType).not.toHaveBeenCalled();
  });

  it("sorts probed pools into cdp / reserve sets; drops unknown and ols", async () => {
    mockDetectStrategyType
      .mockResolvedValueOnce("cdp")
      .mockResolvedValueOnce("reserve")
      .mockResolvedValueOnce("ols")
      .mockResolvedValueOnce("unknown");

    const result = await detectProbedStrategies(CELO, [
      makePool(POOL_A, REB_CDP),
      makePool(POOL_B, REB_RESERVE),
      makePool(POOL_C, REB_OLS),
      makePool(
        "0x000000000000000000000000000000000000dead",
        "0x000000000000000000000000000000000000beef",
      ),
    ]);

    expect(result.cdpPoolIds).toEqual(new Set([`${CELO.chainId}-${POOL_A}`]));
    expect(result.reservePoolIds).toEqual(
      new Set([`${CELO.chainId}-${POOL_B}`]),
    );
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(4);
  });

  it("leaves pools OUT of both sets when the probe fails (detection unavailable)", async () => {
    mockDetectStrategyType.mockRejectedValueOnce(new Error("rpc down"));

    const result = await detectProbedStrategies(CELO, [
      makePool(POOL_A, REB_CDP),
    ]);

    // The whole point of the tri-state: probe failure !== known Reserve.
    expect(result.cdpPoolIds.has(`${CELO.chainId}-${POOL_A}`)).toBe(false);
    expect(result.reservePoolIds.has(`${CELO.chainId}-${POOL_A}`)).toBe(false);
  });

  it("returns the successful sibling classification when one rebalancer in the batch fails", async () => {
    mockDetectStrategyType.mockImplementation(
      async (_client, strategy: `0x${string}`) => {
        if (strategy.toLowerCase() === REB_RESERVE) throw new Error("rpc down");
        return "cdp";
      },
    );

    const result = await detectProbedStrategies(CELO, [
      makePool(POOL_A, REB_CDP),
      makePool(POOL_B, REB_RESERVE),
    ]);

    expect(result.cdpPoolIds).toEqual(new Set([`${CELO.chainId}-${POOL_A}`]));
    expect(result.reservePoolIds.has(`${CELO.chainId}-${POOL_B}`)).toBe(false);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("probes each unique rebalancer once even when many pools share it", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    const result = await detectProbedStrategies(CELO, [
      makePool(POOL_A, REB_SHARED),
      makePool(POOL_B, REB_SHARED),
      makePool(POOL_C, REB_SHARED),
    ]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
    expect(result.cdpPoolIds.size).toBe(3);
  });

  it("keys the cache by lowercased rebalancer across separate calls", async () => {
    // First call with mixed-case address populates the cache.
    mockDetectStrategyType.mockResolvedValueOnce("cdp");
    await detectProbedStrategies(CELO, [
      makePool(POOL_A, REB_CDP.toUpperCase().replace("0X", "0x")),
    ]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);

    // Second call with canonical-lowercase form must hit the cache —
    // if `cacheKey` kept raw casing this would re-probe.
    const result = await detectProbedStrategies(CELO, [
      makePool(POOL_B, REB_CDP),
    ]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
    expect(result.cdpPoolIds).toEqual(new Set([`${CELO.chainId}-${POOL_B}`]));
  });

  it("reuses cached results across calls within the TTL", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectProbedStrategies(CELO, [makePool(POOL_A, REB_CDP)]);
    await detectProbedStrategies(CELO, [makePool(POOL_B, REB_CDP)]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the cache TTL expires", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T00:00:00Z");
    vi.setSystemTime(now);

    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectProbedStrategies(CELO, [makePool(POOL_A, REB_CDP)]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(1);

    // Advance past the 1-hour TTL.
    vi.setSystemTime(new Date(now.getTime() + 61 * 60 * 1000));

    await detectProbedStrategies(CELO, [makePool(POOL_B, REB_CDP)]);
    expect(mockDetectStrategyType).toHaveBeenCalledTimes(2);
  });

  it("scopes cache per network.id, not chainId — same-chain variants don't leak", async () => {
    // Both networks share chainId 42220 but are different deployments.
    // Cache keyed on chainId alone would reuse the first result.
    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectProbedStrategies(CELO, [makePool(POOL_A, REB_SHARED)]);
    await detectProbedStrategies(CELO_DEVNET, [
      makePool(POOL_B, REB_SHARED, CELO_DEVNET.chainId),
    ]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(2);
  });

  it("keeps cache entries per-network so different chains probe independently", async () => {
    mockDetectStrategyType.mockResolvedValue("cdp");

    await detectProbedStrategies(CELO, [makePool(POOL_A, REB_SHARED)]);
    await detectProbedStrategies(MONAD, [
      makePool(POOL_B, REB_SHARED, MONAD.chainId),
    ]);

    expect(mockDetectStrategyType).toHaveBeenCalledTimes(2);
  });

  it("throttles Sentry captures so a flaky rebalancer doesn't spam on every poll", async () => {
    mockDetectStrategyType.mockRejectedValue(new Error("rpc down"));

    // Fire three consecutive polls for the same rebalancer.
    await detectProbedStrategies(CELO, [makePool(POOL_A, REB_CDP)]);
    await detectProbedStrategies(CELO, [makePool(POOL_A, REB_CDP)]);
    await detectProbedStrategies(CELO, [makePool(POOL_A, REB_CDP)]);

    // Only the first failure captures; the other two are throttled.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          source: "strategy-detection",
          network: CELO.id,
          rebalancer: REB_CDP.toLowerCase(),
        }),
      }),
    );
  });

  it("times out a slow probe rather than blowing the outer request budget", async () => {
    vi.useFakeTimers();
    mockDetectStrategyType.mockImplementation(() => new Promise(() => {}));

    const pending = detectProbedStrategies(CELO, [makePool(POOL_A, REB_CDP)]);
    await vi.advanceTimersByTimeAsync(3500);
    const result = await pending;

    expect(result.cdpPoolIds.size).toBe(0);
    expect(result.reservePoolIds.size).toBe(0);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("timed out"),
      }),
      expect.anything(),
    );
  });
});
