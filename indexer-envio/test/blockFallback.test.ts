/// <reference types="mocha" />
import { strict as assert } from "assert";
import {
  readContractWithBlockFallback,
  type BlockFallbackResult,
} from "../src/rpc";

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
  // Fallback retry behavior
  // -------------------------------------------------------------------------

  it("retries without blockNumber on 'block is out of range', usedFallback=true", async () => {
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
    assert.equal(callCount, 2);
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
    it(`retries on provider variant: "${errorMsg}"`, async () => {
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
      assert.equal(callCount, 2);
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

  it("propagates retry failure", async () => {
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
    assert.equal(callCount, 2);
  });

  // -------------------------------------------------------------------------
  // Arg preservation
  // -------------------------------------------------------------------------

  it("preserves all args except blockNumber on retry", async () => {
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
    assert.equal(calls.length, 2);
    // First call: has blockNumber
    assert.equal((calls[0] as any).blockNumber, 42n);
    assert.equal((calls[0] as any).functionName, "bar");
    assert.deepEqual((calls[0] as any).args, ["0xfeed"]);
    // Retry: no blockNumber, same args
    assert.equal((calls[1] as any).blockNumber, undefined);
    assert.equal((calls[1] as any).functionName, "bar");
    assert.deepEqual((calls[1] as any).args, ["0xfeed"]);
  });
});
