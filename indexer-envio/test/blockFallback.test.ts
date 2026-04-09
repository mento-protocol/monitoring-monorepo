/// <reference types="mocha" />
import { strict as assert } from "assert";
import { readContractWithBlockFallback, _testHooks } from "../src/rpc";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

type ReadContractFn = (args: Record<string, unknown>) => Promise<unknown>;

/** Build a minimal mock viem client whose readContract behaviour is controlled
 *  by the provided function. */
function mockClient(readContract: ReadContractFn) {
  return { readContract } as any;
}

// ---------------------------------------------------------------------------
// readContractWithBlockFallback
// ---------------------------------------------------------------------------

describe("readContractWithBlockFallback", () => {
  const baseArgs = {
    address: "0xtest",
    abi: [],
    functionName: "foo",
  };

  // Replace the delay function with an instant no-op for tests.
  let originalDelayFn: typeof _testHooks.delayFn;
  before(() => {
    originalDelayFn = _testHooks.delayFn;
    _testHooks.delayFn = async () => {};
  });
  after(() => {
    _testHooks.delayFn = originalDelayFn;
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("calls with blockNumber when provided, usedFallback=false", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return "ok";
    });
    const res = await readContractWithBlockFallback(client, baseArgs, 100n);
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, false);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as any).blockNumber, 100n);
  });

  it("calls without blockNumber when not provided, usedFallback=false", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return "ok";
    });
    const res = await readContractWithBlockFallback(
      client,
      baseArgs,
      undefined,
    );
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, false);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as any).blockNumber, undefined);
  });

  // -------------------------------------------------------------------------
  // Retry behavior: retries with original block before falling back
  // -------------------------------------------------------------------------

  it("retries original block 3 times then falls back to latest, usedFallback=true", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if ((args as any).blockNumber !== undefined) {
        throw new Error("block is out of range");
      }
      return "fallback-ok";
    });
    const res = await readContractWithBlockFallback(client, baseArgs, 100n);
    assert.equal(res.result, "fallback-ok");
    assert.equal(res.usedFallback, true);
    // 1 initial + 3 retries + 1 fallback (latest) = 5
    assert.equal(callCount, 5);
  });

  it("succeeds on second retry without falling back", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if ((args as any).blockNumber !== undefined && callCount < 3) {
        throw new Error("block is out of range");
      }
      return "retry-ok";
    });
    const res = await readContractWithBlockFallback(client, baseArgs, 100n);
    assert.equal(res.result, "retry-ok");
    assert.equal(res.usedFallback, false);
    // 1 initial + 1 failed retry + 1 successful retry = 3
    assert.equal(callCount, 3);
  });

  it("succeeds on first retry without falling back", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if ((args as any).blockNumber !== undefined && callCount < 2) {
        throw new Error("block is out of range");
      }
      return "retry-ok";
    });
    const res = await readContractWithBlockFallback(client, baseArgs, 100n);
    assert.equal(res.result, "retry-ok");
    assert.equal(res.usedFallback, false);
    // 1 initial + 1 successful retry = 2
    assert.equal(callCount, 2);
  });

  it("tracks delay values passed to the delay function", async () => {
    const delays: number[] = [];
    _testHooks.delayFn = async (ms) => {
      delays.push(ms);
    };
    try {
      const client = mockClient(async (args) => {
        if ((args as any).blockNumber !== undefined) {
          throw new Error("block is out of range");
        }
        return "ok";
      });
      await readContractWithBlockFallback(client, baseArgs, 100n);
      assert.deepEqual(delays, [500, 1000, 2000]);
    } finally {
      _testHooks.delayFn = async () => {};
    }
  });

  // -------------------------------------------------------------------------
  // Broader error message variants (different RPC providers)
  // -------------------------------------------------------------------------

  for (const errorMsg of [
    "block number out of range",
    "header not found",
    "unknown block",
    "Header Not Found", // case-insensitive
    "BLOCK IS OUT OF RANGE", // case-insensitive
  ]) {
    it(`retries and falls back on provider variant: "${errorMsg}"`, async () => {
      let callCount = 0;
      const client = mockClient(async (args) => {
        callCount++;
        if ((args as any).blockNumber !== undefined) {
          throw new Error(errorMsg);
        }
        return "ok";
      });
      const res = await readContractWithBlockFallback(client, baseArgs, 100n);
      assert.equal(res.result, "ok");
      assert.equal(res.usedFallback, true);
      // 1 initial + 3 retries + 1 fallback = 5
      assert.equal(callCount, 5);
    });
  }

  // -------------------------------------------------------------------------
  // No-retry conditions
  // -------------------------------------------------------------------------

  it("does not retry when blockNumber is undefined", async () => {
    let callCount = 0;
    const client = mockClient(async () => {
      callCount++;
      throw new Error("block is out of range");
    });
    await assert.rejects(
      () => readContractWithBlockFallback(client, baseArgs, undefined),
      { message: "block is out of range" },
    );
    assert.equal(callCount, 1);
  });

  it("does not retry on unrelated errors", async () => {
    let callCount = 0;
    const client = mockClient(async () => {
      callCount++;
      throw new Error("execution reverted");
    });
    await assert.rejects(
      () => readContractWithBlockFallback(client, baseArgs, 100n),
      { message: "execution reverted" },
    );
    assert.equal(callCount, 1);
  });

  it("does not retry on non-Error throws", async () => {
    let callCount = 0;
    const client = mockClient(async () => {
      callCount++;
      throw "string error";
    });
    await assert.rejects(() =>
      readContractWithBlockFallback(client, baseArgs, 100n),
    );
    assert.equal(callCount, 1);
  });

  // -------------------------------------------------------------------------
  // Retry failure propagation
  // -------------------------------------------------------------------------

  it("propagates non-block error from fallback (latest) call", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if ((args as any).blockNumber !== undefined) {
        throw new Error("block is out of range");
      }
      throw new Error("node is down");
    });
    await assert.rejects(
      () => readContractWithBlockFallback(client, baseArgs, 100n),
      { message: "node is down" },
    );
    // 1 initial + 3 retries + 1 fallback (fails) = 5
    assert.equal(callCount, 5);
  });

  it("propagates non-block error that occurs during a retry", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("block is out of range");
      }
      // Second call (first retry) throws a different error
      throw new Error("execution reverted");
    });
    await assert.rejects(
      () => readContractWithBlockFallback(client, baseArgs, 100n),
      { message: "execution reverted" },
    );
    // 1 initial + 1 retry that throws different error = 2
    assert.equal(callCount, 2);
  });

  // -------------------------------------------------------------------------
  // Arg preservation
  // -------------------------------------------------------------------------

  it("preserves all args except blockNumber on fallback", async () => {
    const calls: Record<string, unknown>[] = [];
    const argsWithExtra = {
      address: "0xabc",
      abi: [{ name: "test" }],
      functionName: "bar",
      args: ["0xfeed"],
    };
    const client = mockClient(async (args) => {
      calls.push({ ...args });
      if ((args as any).blockNumber !== undefined) {
        throw new Error("block is out of range");
      }
      return "ok";
    });
    await readContractWithBlockFallback(client, argsWithExtra, 42n);
    // 1 initial + 3 retries (all with blockNumber) + 1 fallback (no blockNumber) = 5
    assert.equal(calls.length, 5);
    // First 4 calls: has blockNumber
    for (let i = 0; i < 4; i++) {
      assert.equal((calls[i] as any).blockNumber, 42n);
      assert.equal((calls[i] as any).functionName, "bar");
      assert.deepEqual((calls[i] as any).args, ["0xfeed"]);
    }
    // Fallback: no blockNumber, same args
    assert.equal((calls[4] as any).blockNumber, undefined);
    assert.equal((calls[4] as any).functionName, "bar");
    assert.deepEqual((calls[4] as any).args, ["0xfeed"]);
  });
});
