/// <reference types="mocha" />
import { strict as assert } from "assert";
import { readContractWithBlockFallback } from "../src/rpc";

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

  it("calls with blockNumber when provided", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return "ok";
    });
    const result = await readContractWithBlockFallback(client, baseArgs, 100n);
    assert.equal(result, "ok");
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as any).blockNumber, 100n);
  });

  it("calls without blockNumber when not provided", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return "ok";
    });
    const result = await readContractWithBlockFallback(
      client,
      baseArgs,
      undefined,
    );
    assert.equal(result, "ok");
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as any).blockNumber, undefined);
  });

  it("retries without blockNumber on 'block is out of range'", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if ((args as any).blockNumber !== undefined) {
        throw new Error("block is out of range");
      }
      return "fallback-ok";
    });
    const result = await readContractWithBlockFallback(client, baseArgs, 100n);
    assert.equal(result, "fallback-ok");
    assert.equal(callCount, 2);
  });

  it("does not retry when blockNumber is undefined and error contains 'block is out of range'", async () => {
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
