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

  // -------------------------------------------------------------------------
  // Archive-depth fallback (primary's archive doesn't reach this block, but
  // a deeper-archive secondary does). Distinct from rate-limit fallback
  // because the secondary is consulted on the archive-depth error pattern,
  // not just rate-limit. Distinct from block-not-available because the
  // recovery is the SAME block on a deeper RPC, not `latest` on the same RPC.
  // -------------------------------------------------------------------------

  it("archive-depth: secondary at SAME block returns block-scoped result", async () => {
    const primaryCalls: Record<string, unknown>[] = [];
    const fallbackCalls: Record<string, unknown>[] = [];
    const primary = mockClient(async (args) => {
      primaryCalls.push({ ...args });
      throw new Error(
        "Block requested not found. Request might be querying historical state that is not available.",
      );
    });
    const fallback = mockClient(async (args) => {
      fallbackCalls.push({ ...args });
      return "deep-archive-result";
    });
    const res = await readContractWithBlockFallback(
      primary,
      baseArgs,
      68202836n,
      fallback,
    );
    assert.equal(res.result, "deep-archive-result");
    assert.equal(res.usedFallback, true);
    assert.equal(
      res.usedLatestFallback,
      false,
      "block-scoped accuracy must be preserved when secondary returns at the same block",
    );
    assert.equal(
      primaryCalls.length,
      1,
      "no retries on primary for archive-depth",
    );
    assert.equal(fallbackCalls.length, 1);
    assert.equal((fallbackCalls[0] as any).blockNumber, 68202836n);
  });

  it("archive-depth: matches 'querying historical state' phrasing too", async () => {
    const primary = mockClient(async () => {
      throw new Error(
        "RPC error: querying historical state that is not available on this node",
      );
    });
    const fallback = mockClient(async () => "ok");
    const res = await readContractWithBlockFallback(
      primary,
      baseArgs,
      100n,
      fallback,
    );
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, true);
    assert.equal(res.usedLatestFallback, false);
  });

  it("archive-depth: secondary also fails → throws (fail-closed)", async () => {
    // Pre-PR behaviour preserved: archive-depth + secondary failure
    // throws to the caller. We must NOT silently fall through to `latest`
    // because many call sites consume `result` without checking
    // `usedLatestFallback` — that would corrupt historical entity state
    // with current-block data.
    const primary = mockClient(async () => {
      throw new Error(
        "querying historical state that is not available on this node",
      );
    });
    const fallback = mockClient(async () => {
      throw new Error("rate limit"); // Secondary itself rate-limits
    });
    await assert.rejects(
      readContractWithBlockFallback(primary, baseArgs, 100n, fallback),
      /rate limit/,
      "should propagate the secondary error, not swallow it into a latest read",
    );
  });

  it("archive-depth: secondary returns 'returned no data' → throws so caller classifies it", async () => {
    // The 'returned no data' classification matters: e.g.
    // fetchRebalanceIncentiveAtBlock stamps a -2 sentinel for older pools
    // missing the getter. Eating this into a `latest` read would replace
    // the legitimate "getter doesn't exist" signal with current-block
    // contract state.
    const primary = mockClient(async () => {
      throw new Error("querying historical state");
    });
    const fallback = mockClient(async () => {
      throw new Error('The contract function "x" returned no data ("0x").');
    });
    await assert.rejects(
      readContractWithBlockFallback(primary, baseArgs, 100n, fallback),
      /returned no data/,
      "should propagate the 'returned no data' error so the caller can stamp the -2 sentinel",
    );
  });

  it("archive-depth: no fallback configured → throws original error", async () => {
    let primaryCallNo = 0;
    const primary = mockClient(async () => {
      primaryCallNo++;
      throw new Error(
        "Block requested not found. Request might be querying historical state that is not available.",
      );
    });
    await assert.rejects(
      readContractWithBlockFallback(primary, baseArgs, 100n, null),
      /querying historical state/,
      "no fallback → must throw, not silently use latest",
    );
    assert.equal(
      primaryCallNo,
      1,
      "no retry loop on primary for archive-depth (would deterministically fail)",
    );
  });

  it("archive-depth: error surfaced AFTER rate-limit retry routes to secondary at same block", async () => {
    // Production scenario the targeted Codex P2 finding flagged: shallow
    // primary returns 429 first, our retries wait it out, then the next
    // attempt returns the archive-depth error. Pre-fix this short-
    // circuited (non-rate-limit retry error → throw), bypassing the
    // same-block secondary.
    let primaryCallNo = 0;
    const primary = mockClient(async () => {
      primaryCallNo++;
      if (primaryCallNo === 1) throw new Error("rate limit exceeded");
      throw new Error(
        "querying historical state that is not available on this node",
      );
    });
    const fallback = mockClient(async () => "secondary-block-scoped");
    const res = await readContractWithBlockFallback(
      primary,
      baseArgs,
      100n,
      fallback,
    );
    assert.equal(res.result, "secondary-block-scoped");
    assert.equal(res.usedFallback, true);
    assert.equal(
      res.usedLatestFallback,
      false,
      "block-scoped result, not latest — secondary is consulted at the requested block even when the archive-depth error surfaced after the rate-limit cleared",
    );
  });

  it("archive-depth: secondary error sanitization redacts URL-bearing messages before logging", async () => {
    // Tokenized RPC URLs (HyperRPC, quiknode-with-token) can appear in
    // viem error stacks. The diagnostic warning must redact them so logs
    // don't leak credentials. We capture stderr via console.warn
    // monkeypatch to assert.
    const origWarn = console.warn;
    const captured: string[] = [];
    console.warn = (...m: unknown[]) => {
      captured.push(m.join(" "));
    };
    try {
      const primary = mockClient(async () => {
        throw new Error("querying historical state");
      });
      const fallback = mockClient(async () => {
        throw new Error(
          'HTTP request failed. URL: "https://misty.quiknode.pro/SECRET-TOKEN-12345" reason: timeout',
        );
      });
      await assert.rejects(
        readContractWithBlockFallback(primary, baseArgs, 100n, fallback),
      );
      const fallbackFailedLine = captured.find((l) =>
        l.includes("RPC_ARCHIVE_FALLBACK_FAILED"),
      );
      assert.ok(
        fallbackFailedLine,
        "archive-fallback-failed warning must fire",
      );
      assert.ok(
        !fallbackFailedLine.includes("SECRET-TOKEN-12345"),
        "secondary error message must be sanitized (token-bearing URL redacted)",
      );
      assert.ok(
        fallbackFailedLine.includes("<redacted>"),
        "sanitized URL replacement marker must appear",
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("archive-depth regex: bare 'block requested not found' (no historical-state qualifier) does NOT trigger archive-depth path", async () => {
    // Some providers may emit the bare phrase for transient lag (the node
    // hasn't seen this block yet) rather than archive-depth pruning.
    // Mis-classifying that as archive-depth would skip the retry-then-
    // latest path — this test pins the regex to the unambiguous
    // historical-state marker.
    let primaryCallNo = 0;
    const primary = mockClient(async (args) => {
      primaryCallNo++;
      if ((args as any).blockNumber !== undefined) {
        // The first call AND the retries throw with bare block-miss phrasing
        // — but the regex narrowing means this doesn't enter the
        // archive-depth branch. It also doesn't match BLOCK_NOT_AVAILABLE_RE
        // (which expects "block is out of range" / "header not found" /
        // etc.), so it propagates as an unrecognised error.
        throw new Error("Block requested not found");
      }
      return "latest-result";
    });
    await assert.rejects(
      readContractWithBlockFallback(primary, baseArgs, 100n, null),
      /Block requested not found/,
      "bare 'block requested not found' is treated as an unrecognised error, not archive-depth",
    );
    assert.equal(
      primaryCallNo,
      1,
      "no retries / latest-fallback for unrecognised errors",
    );
  });
});
