import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  _clearBreakerMocks,
  _clearRpcClients,
  _setRpcClientForTests,
  _testHooks,
  fetchBreakerDefaults,
  fetchBreakerFeedState,
  fetchBreakerList,
  fetchRateFeedOracles,
  fetchReportExpiry,
  fetchRebalanceThresholds,
  fetchReserves,
  fetchTradingLimits,
} from "../src/rpc.ts";
import {
  _clearMockStableTotalSupply,
  _setMockStableTotalSupply,
  fetchStableTotalSupply,
} from "../src/rpc/stable-fetchers.ts";
import { fetchBlockTimestamp } from "../src/rpc.ts";

const CHAIN_ID = 42220;
const POOL = "0x00000000000000000000000000000000000000aa";
const TOKEN = "0x00000000000000000000000000000000000000bb";
const BREAKER = "0x00000000000000000000000000000000000000cc";
const FEED = "0x000000000000000000000000000000000000beef";
const BLOCK = 60_700_000n;

type ReadContractArgs = {
  functionName?: string;
  blockNumber?: bigint;
};

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("RPC fetchers reject non-historical latest fallbacks", () => {
  let originalDelayFn: typeof _testHooks.delayFn;

  beforeAll(() => {
    originalDelayFn = _testHooks.delayFn;
    _testHooks.delayFn = async () => {};
  });

  beforeEach(() => {
    _clearRpcClients();
    _clearBreakerMocks();
    _clearMockStableTotalSupply();
  });

  afterAll(() => {
    _testHooks.delayFn = originalDelayFn;
    _clearRpcClients();
    _clearBreakerMocks();
    _clearMockStableTotalSupply();
  });

  it("fetchReserves returns null instead of accepting latest-block reserves", async () => {
    const calls: ReadContractArgs[] = [];
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        calls.push(call);
        if (call.blockNumber !== undefined) throw new Error("header not found");
        return [1n, 2n, 0n];
      },
    });

    const result = await fetchReserves(CHAIN_ID, POOL, BLOCK, noopLogger);

    assert.equal(result, null);
    assert.equal(calls.length, 5);
    assert.equal(calls.at(-1)?.blockNumber, undefined);
  });

  it("fetchBlockTimestamp reads historical block timestamps by number", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      getBlock: async (args) => {
        assert.deepEqual(args, { blockNumber: BLOCK });
        return { timestamp: 1_780_444_800n };
      },
    });

    const result = await fetchBlockTimestamp(CHAIN_ID, BLOCK, noopLogger);

    assert.equal(result, 1_780_444_800n);
  });

  it("fetchRebalanceThresholds fails closed when either threshold uses latest fallback", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        if (
          call.functionName === "rebalanceThresholdBelow" &&
          call.blockNumber !== undefined
        ) {
          throw new Error("header not found");
        }
        return call.functionName === "rebalanceThresholdAbove" ? 200n : 50n;
      },
    });

    const result = await fetchRebalanceThresholds(
      CHAIN_ID,
      POOL,
      BLOCK,
      noopLogger,
    );

    assert.equal(result, null);
  });

  it("fetchTradingLimits returns null for latest fallback state", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        if (call.blockNumber !== undefined) throw new Error("header not found");
        return [
          { limit0: 100n, limit1: 200n, decimals: 18 },
          {
            lastUpdated0: 10,
            lastUpdated1: 20,
            netflow0: 1n,
            netflow1: 2n,
          },
        ];
      },
    });

    const result = await fetchTradingLimits(
      CHAIN_ID,
      POOL,
      TOKEN,
      BLOCK,
      noopLogger,
    );

    assert.equal(result, null);
  });

  it("fetchRateFeedOracles returns null instead of current oracle membership", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        if (call.blockNumber !== undefined) throw new Error("header not found");
        return ["0x0000000000000000000000000000000000000001"];
      },
    });

    const result = await fetchRateFeedOracles(
      CHAIN_ID,
      FEED,
      BLOCK,
      noopLogger,
    );

    assert.equal(result, null);
  });

  it("fetchReportExpiry returns null when the global-expiry fallback is latest", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        if (call.functionName === "tokenReportExpirySeconds") return 0n;
        if (call.blockNumber !== undefined) throw new Error("header not found");
        return 3600n;
      },
    });

    const result = await fetchReportExpiry(CHAIN_ID, FEED, BLOCK, noopLogger);

    assert.equal(result, null);
  });

  it("fetchBreakerList returns null instead of seeding current breakers historically", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        if (call.blockNumber !== undefined) throw new Error("header not found");
        return [BREAKER];
      },
    });

    const result = await fetchBreakerList(CHAIN_ID, BLOCK, noopLogger);

    assert.equal(result, null);
  });

  it("fetchBreakerDefaults rejects a latest fallback from any default getter", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        if (
          call.functionName === "defaultCooldownTime" &&
          call.blockNumber !== undefined
        ) {
          throw new Error("header not found");
        }
        if (call.functionName === "breakerTradingMode") return 3;
        if (call.functionName === "defaultCooldownTime") return 900n;
        return 5n;
      },
    });

    const result = await fetchBreakerDefaults(
      CHAIN_ID,
      BREAKER,
      "MEDIAN_DELTA",
      BLOCK,
      noopLogger,
    );

    assert.equal(result, null);
  });

  it("fetchBreakerDefaults fills MARKET_HOURS sentinel defaults from status only", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async () => 4,
    });

    const result = await fetchBreakerDefaults(
      CHAIN_ID,
      BREAKER,
      "MARKET_HOURS",
      BLOCK,
      noopLogger,
    );

    assert.deepEqual(result, {
      activatesTradingMode: 4,
      defaultCooldownTime: 0n,
      defaultRateChangeThreshold: 0n,
    });
  });

  it("fetchBreakerFeedState maps MARKET_HOURS tuple status to sentinel fields", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async () => [7, 1234n, true],
    });

    const result = await fetchBreakerFeedState(
      CHAIN_ID,
      BREAKER,
      "MARKET_HOURS",
      FEED,
      BLOCK,
      noopLogger,
    );

    assert.deepEqual(result, {
      enabled: true,
      tradingMode: 7,
      lastStatusUpdatedAt: 1234n,
      cooldownTime: 0n,
      rateChangeThreshold: 0n,
      smoothingFactor: null,
      medianRatesEMA: null,
      referenceValue: null,
    });
  });

  it("fetchStableTotalSupply uses the exact block mock before RPC", async () => {
    _setMockStableTotalSupply(CHAIN_ID, TOKEN, BLOCK, 123n);

    assert.equal(
      await fetchStableTotalSupply(CHAIN_ID, TOKEN, BLOCK, noopLogger),
      123n,
    );
  });

  it("fetchStableTotalSupply rejects latest fallback baselines", async () => {
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const call = args as ReadContractArgs;
        if (call.blockNumber !== undefined) throw new Error("header not found");
        return 999n;
      },
    });

    const result = await fetchStableTotalSupply(
      CHAIN_ID,
      TOKEN,
      BLOCK,
      noopLogger,
    );

    assert.equal(result, null);
  });

  it("fetchStableTotalSupply treats pre-deployment no-data as a zero baseline", async () => {
    const info: string[] = [];
    const logger = {
      ...noopLogger,
      info: (msg: string) => info.push(msg),
    };
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async () => {
        throw new Error(
          'The contract function "totalSupply" returned no data ("0x").',
        );
      },
    });

    const result = await fetchStableTotalSupply(CHAIN_ID, TOKEN, BLOCK, logger);

    assert.equal(result, 0n);
    assert.ok(info.some((line) => line.includes("pre-deployment block")));
  });
});
