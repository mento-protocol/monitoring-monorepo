import { strict as assert } from "assert";
import type { createPublicClient } from "viem";
import { readContractWithBlockFallback, _testHooks } from "../src/rpc.js";
import {
  _resetFallbackArchiveDepth,
  fallbackLikelyHasBlock,
  recordFallbackArchiveMiss,
} from "../src/rpc/client.js";

// Most tests don't care which chainId they use — they just need a stable,
// distinct value so the per-chain archive-horizon Map doesn't bleed state
// across tests with unrelated fixtures.
const TEST_CHAIN_ID = 999_001;

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

type PublicClient = ReturnType<typeof createPublicClient>;
type MockReadContractArgs = Record<string, unknown> & {
  blockNumber?: bigint;
  functionName?: string;
  args?: unknown;
};
type ReadContractFn = (args: MockReadContractArgs) => Promise<unknown>;
type CapturedLogs = { debug: string[]; info: string[]; warn: string[] };

/** Build a minimal mock viem client whose readContract behaviour is controlled
 *  by the provided function. */
function mockClient(readContract: ReadContractFn): PublicClient {
  return { readContract } as unknown as PublicClient;
}

function captureLogs(): CapturedLogs & {
  logger: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
} {
  const captured: CapturedLogs = { debug: [], info: [], warn: [] };
  return {
    ...captured,
    logger: {
      debug: (msg: string) => captured.debug.push(msg),
      info: (msg: string) => captured.info.push(msg),
      warn: (msg: string) => captured.warn.push(msg),
      error: () => {},
    },
  };
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
  let originalNowFn: typeof _testHooks.nowFn;
  let nowMs = 0;
  beforeAll(() => {
    originalDelayFn = _testHooks.delayFn;
    originalNowFn = _testHooks.nowFn;
    _testHooks.delayFn = async () => {};
    _testHooks.nowFn = () => nowMs;
  });
  beforeEach(() => {
    nowMs = 0;
    _testHooks.resetFallbackRuntimeState();
  });
  afterAll(() => {
    _testHooks.delayFn = originalDelayFn;
    _testHooks.nowFn = originalNowFn;
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("calls with blockNumber when provided, usedFallback=false", async () => {
    const calls: MockReadContractArgs[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return "ok";
    });
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      client,
      baseArgs,
      100n,
    );
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].blockNumber, 100n);
  });

  it("calls without blockNumber when not provided, usedFallback=false", async () => {
    const calls: MockReadContractArgs[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return "ok";
    });
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      client,
      baseArgs,
      undefined,
    );
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].blockNumber, undefined);
  });

  // -------------------------------------------------------------------------
  // Retry behavior: retries with original block before falling back
  // -------------------------------------------------------------------------

  it("retries original block 3 times then falls back to latest, usedFallback=true", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if (args.blockNumber !== undefined) {
        throw new Error("block is out of range");
      }
      return "fallback-ok";
    });
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      client,
      baseArgs,
      100n,
    );
    assert.equal(res.result, "fallback-ok");
    assert.equal(res.usedFallback, true);
    // 1 initial + 3 retries + 1 fallback (latest) = 5
    assert.equal(callCount, 5);
  });

  it("tries secondary at the same block before latest after block-lag retries", async () => {
    const primaryCalls: MockReadContractArgs[] = [];
    const fallbackCalls: MockReadContractArgs[] = [];
    const primary = mockClient(async (args) => {
      primaryCalls.push({ ...args });
      if (args.blockNumber !== undefined) {
        throw new Error("header not found");
      }
      return "latest-result";
    });
    const fallback = mockClient(async (args) => {
      fallbackCalls.push({ ...args });
      return "secondary-block-result";
    });

    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      100n,
      fallback,
    );

    assert.equal(res.result, "secondary-block-result");
    assert.equal(res.usedFallback, true);
    assert.equal(res.usedLatestFallback, false);
    // 1 initial + 3 retries; no latest read because secondary succeeded.
    assert.equal(primaryCalls.length, 4);
    assert.equal(fallbackCalls.length, 1);
    assert.equal(fallbackCalls[0].blockNumber, 100n);
  });

  it("succeeds on second retry without falling back", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if (args.blockNumber !== undefined && callCount < 3) {
        throw new Error("block is out of range");
      }
      return "retry-ok";
    });
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      client,
      baseArgs,
      100n,
    );
    assert.equal(res.result, "retry-ok");
    assert.equal(res.usedFallback, false);
    // 1 initial + 1 failed retry + 1 successful retry = 3
    assert.equal(callCount, 3);
  });

  it("succeeds on first retry without falling back", async () => {
    let callCount = 0;
    const client = mockClient(async (args) => {
      callCount++;
      if (args.blockNumber !== undefined && callCount < 2) {
        throw new Error("block is out of range");
      }
      return "retry-ok";
    });
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      client,
      baseArgs,
      100n,
    );
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
        if (args.blockNumber !== undefined) {
          throw new Error("block is out of range");
        }
        return "ok";
      });
      await readContractWithBlockFallback(
        TEST_CHAIN_ID,
        client,
        baseArgs,
        100n,
      );
      assert.deepStrictEqual(delays, [500, 1000, 2000]);
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
        if (args.blockNumber !== undefined) {
          throw new Error(errorMsg);
        }
        return "ok";
      });
      const res = await readContractWithBlockFallback(
        TEST_CHAIN_ID,
        client,
        baseArgs,
        100n,
      );
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
      () =>
        readContractWithBlockFallback(
          TEST_CHAIN_ID,
          client,
          baseArgs,
          undefined,
        ),
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
      () =>
        readContractWithBlockFallback(TEST_CHAIN_ID, client, baseArgs, 100n),
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
      readContractWithBlockFallback(TEST_CHAIN_ID, client, baseArgs, 100n),
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
      if (args.blockNumber !== undefined) {
        throw new Error("block is out of range");
      }
      throw new Error("node is down");
    });
    await assert.rejects(
      () =>
        readContractWithBlockFallback(TEST_CHAIN_ID, client, baseArgs, 100n),
      { message: "node is down" },
    );
    // 1 initial + 3 retries + 1 fallback (fails) = 5
    assert.equal(callCount, 5);
  });

  it("propagates non-block error that occurs during a retry", async () => {
    let callCount = 0;
    const client = mockClient(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("block is out of range");
      }
      // Second call (first retry) throws a different error
      throw new Error("execution reverted");
    });
    await assert.rejects(
      () =>
        readContractWithBlockFallback(TEST_CHAIN_ID, client, baseArgs, 100n),
      { message: "execution reverted" },
    );
    // 1 initial + 1 retry that throws different error = 2
    assert.equal(callCount, 2);
  });

  // -------------------------------------------------------------------------
  // Arg preservation
  // -------------------------------------------------------------------------

  it("preserves all args except blockNumber on fallback", async () => {
    const calls: MockReadContractArgs[] = [];
    const argsWithExtra = {
      address: "0xabc",
      abi: [{ name: "test" }],
      functionName: "bar",
      args: ["0xfeed"],
    };
    const client = mockClient(async (args) => {
      calls.push({ ...args });
      if (args.blockNumber !== undefined) {
        throw new Error("block is out of range");
      }
      return "ok";
    });
    await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      client,
      argsWithExtra,
      42n,
    );
    // 1 initial + 3 retries (all with blockNumber) + 1 fallback (no blockNumber) = 5
    assert.equal(calls.length, 5);
    // First 4 calls: has blockNumber
    for (let i = 0; i < 4; i++) {
      assert.equal(calls[i].blockNumber, 42n);
      assert.equal(calls[i].functionName, "bar");
      assert.deepStrictEqual(calls[i].args, ["0xfeed"]);
    }
    // Fallback: no blockNumber, same args
    assert.equal(calls[4].blockNumber, undefined);
    assert.equal(calls[4].functionName, "bar");
    assert.deepStrictEqual(calls[4].args, ["0xfeed"]);
  });

  // -------------------------------------------------------------------------
  // Archive-depth fallback (primary's archive doesn't reach this block, but
  // a deeper-archive secondary does). Distinct from rate-limit fallback
  // because the secondary is consulted on the archive-depth error pattern,
  // not just rate-limit. Distinct from block-not-available because the
  // recovery is the SAME block on a deeper RPC, not `latest` on the same RPC.
  // -------------------------------------------------------------------------

  it("archive-depth: secondary at SAME block returns block-scoped result", async () => {
    const primaryCalls: MockReadContractArgs[] = [];
    const fallbackCalls: MockReadContractArgs[] = [];
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
      TEST_CHAIN_ID,
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
    assert.equal(fallbackCalls[0].blockNumber, 68202836n);
  });

  it("archive-depth: successful secondary fallback logs debug, not warn", async () => {
    const primary = mockClient(async () => {
      throw new Error(
        "Block requested not found. Request might be querying historical state that is not available. URL: https://rpc.example/secret-token",
      );
    });
    const fallback = mockClient(async () => "deep-archive-result");
    const captured = captureLogs();
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      68202836n,
      fallback,
      captured.logger,
    );
    assert.equal(res.result, "deep-archive-result");
    assert.equal(captured.warn.length, 0);
    assert.equal(captured.debug.length, 1);
    assert.match(captured.debug[0], /\[RPC_ARCHIVE_FALLBACK\]/);
    assert.match(captured.debug[0], /primaryErr=/);
    assert.match(captured.debug[0], /querying historical state/);
    assert.match(captured.debug[0], /https:\/\/rpc.example\/<redacted>/);
    assert.doesNotMatch(captured.debug[0], /secret-token/);
  });

  it("archive-depth: matches 'querying historical state' phrasing too", async () => {
    const primary = mockClient(async () => {
      throw new Error(
        "RPC error: querying historical state that is not available on this node",
      );
    });
    const fallback = mockClient(async () => "ok");
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      100n,
      fallback,
    );
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, true);
    assert.equal(res.usedLatestFallback, false);
  });

  // viem formats `ContractFunctionExecutionError` with a `\n` between
  // sentences, not a single space. The previous literal-space anchor in
  // ARCHIVE_DEPTH_RE silently failed to match production messages even
  // though the unit tests above used a literal space and passed. Keep these
  // two `\n`-separator cases so any future regex regression resurfaces
  // immediately. Mirror the in-the-wild viem output exactly.
  it("archive-depth: 'Invalid parameters were provided' with `\\n` separator (viem-formatted)", async () => {
    const primary = mockClient(async () => {
      throw new Error(
        "Invalid parameters were provided to the RPC method.\nDouble check you have provided the correct parameters.",
      );
    });
    const fallback = mockClient(async () => "ok");
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      100n,
      fallback,
    );
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, true);
    assert.equal(res.usedLatestFallback, false);
  });

  // Third QuickNode first-sentence variant observed 2026-05-22 against
  // recent (non-archive) Celo blocks; broad provider rejection rather than
  // pure archive-depth, but the recovery path is identical (try the
  // secondary at the same block), so it's routed through ARCHIVE_DEPTH_RE.
  it("archive-depth: 'Missing or invalid parameters' (QuickNode 2026-05-22 variant)", async () => {
    const primary = mockClient(async () => {
      throw new Error(
        "Missing or invalid parameters.\nDouble check you have provided the correct parameters.",
      );
    });
    const fallback = mockClient(async () => "ok");
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      100n,
      fallback,
    );
    assert.equal(res.result, "ok");
    assert.equal(res.usedFallback, true);
    assert.equal(res.usedLatestFallback, false);
  });

  // The 'Missing or invalid parameters' variant fires on RECENT blocks
  // during transient provider rejection — NOT genuine archive depth.
  // Pinning the per-chain fallback horizon here would block fallback
  // usage for ~all blocks below that height until process restart, masking
  // a transient glitch as a permanent provider limit. Verify the broad
  // routing pattern is decoupled from the horizon-poisoning subset.
  it("archive-depth: 'Missing or invalid parameters' on BOTH primary and secondary does NOT poison the fallback horizon", async () => {
    const primary = mockClient(async () => {
      throw new Error(
        "Missing or invalid parameters.\nDouble check you have provided the correct parameters.",
      );
    });
    const fallback = mockClient(async () => {
      throw new Error(
        "Missing or invalid parameters.\nDouble check you have provided the correct parameters.",
      );
    });
    await assert.rejects(() =>
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        1_000n,
        fallback,
      ),
    );
    // Horizon must NOT have been pinned at the requested block — a deeper
    // block must still be considered "likely available".
    assert.equal(
      fallbackLikelyHasBlock(TEST_CHAIN_ID, 999n),
      true,
      "transient provider rejection must not pin fallback horizon",
    );
  });

  // Pair test: verify the OLD verified-archive-depth phrasing on both
  // primary and secondary still pins the horizon. Guards against the
  // regex split silently dropping the existing poisoning behavior.
  it("archive-depth: 'Invalid parameters were provided' on BOTH primary and secondary STILL poisons the horizon", async () => {
    const primary = mockClient(async () => {
      throw new Error(
        "Invalid parameters were provided to the RPC method.\nDouble check you have provided the correct parameters.",
      );
    });
    const fallback = mockClient(async () => {
      throw new Error(
        "Invalid parameters were provided to the RPC method.\nDouble check you have provided the correct parameters.",
      );
    });
    await assert.rejects(() =>
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        500n,
        fallback,
      ),
    );
    assert.equal(
      fallbackLikelyHasBlock(TEST_CHAIN_ID, 500n),
      false,
      "verified archive-depth signal must still pin fallback horizon",
    );
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
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        100n,
        fallback,
      ),
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
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        100n,
        fallback,
      ),
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
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        100n,
        null,
      ),
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
      TEST_CHAIN_ID,
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
        readContractWithBlockFallback(
          TEST_CHAIN_ID,
          primary,
          baseArgs,
          100n,
          fallback,
        ),
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
      assert.ok(
        fallbackFailedLine.includes('primaryErr="querying historical state"'),
        "fallback failure line should preserve sanitized primary error",
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("archive-depth: secondary rate limit starts a cooldown for that chain/function", async () => {
    nowMs = 1_000;
    const captured = captureLogs();
    const primary = mockClient(async () => {
      throw new Error("querying historical state");
    });
    let fallbackCalls = 0;
    const fallback = mockClient(async () => {
      fallbackCalls++;
      if (fallbackCalls === 1) {
        throw new Error(
          "Request exceeds defined limit. Details: rate-limit exceeded",
        );
      }
      return "secondary-after-cooldown";
    });

    await assert.rejects(
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        100n,
        fallback,
        captured.logger,
      ),
      /rate-limit exceeded/,
    );
    assert.equal(fallbackCalls, 1);
    assert.match(captured.warn.join("\n"), /RPC_FALLBACK_COOLDOWN_START/);

    await assert.rejects(
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        101n,
        fallback,
        captured.logger,
      ),
      /querying historical state/,
    );
    assert.equal(
      fallbackCalls,
      1,
      "cooldown skips the secondary instead of hammering the fallback",
    );
    assert.match(captured.debug.join("\n"), /RPC_FALLBACK_COOLDOWN/);

    nowMs += 10_001;
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      102n,
      fallback,
      captured.logger,
    );
    assert.equal(res.result, "secondary-after-cooldown");
    assert.equal(fallbackCalls, 2);
  });

  it("archive-depth: emits structured fallback summaries every 50 attempts", async () => {
    const captured = captureLogs();
    const primary = mockClient(async () => {
      throw new Error("querying historical state");
    });
    const fallback = mockClient(async () => "secondary-block-scoped");
    const args = { ...baseArgs, functionName: "summaryFn" };

    for (let i = 0; i < 50; i++) {
      await readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        args,
        BigInt(1_000 + i),
        fallback,
        captured.logger,
      );
    }

    assert.equal(captured.info.length, 1);
    assert.match(captured.info[0], /\[RPC_FALLBACK_SUMMARY\]/);
    assert.match(captured.info[0], /archiveAttempts=50/);
    assert.match(captured.info[0], /archiveSuccesses=49/);
  });

  it("archive-depth: known secondary contract reverts log debug, not fallback-failed warn", async () => {
    const primary = mockClient(async () => {
      throw new Error("querying historical state");
    });
    const fallback = mockClient(async () => {
      throw new Error(
        'The contract function "getRebalancingState" reverted with the following signature:\n0xa407143a',
      );
    });
    const captured = captureLogs();
    await assert.rejects(
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        { ...baseArgs, functionName: "getRebalancingState" },
        100n,
        fallback,
        captured.logger,
      ),
      /0xa407143a/,
    );
    assert.equal(captured.warn.length, 0);
    assert.equal(captured.debug.length, 1);
    assert.match(captured.debug[0], /\[CONTRACT_REVERT\]/);
    assert.match(captured.debug[0], /OracleStaleOrExpired/);
  });

  it("archive-depth regex: bare 'block requested not found' is treated as transient-lag, NOT archive-depth", async () => {
    // The bare phrase (without "querying historical state" qualifier)
    // tends to mean "node hasn't seen this block yet" — a transient lag
    // recoverable via retry-then-latest. ARCHIVE_DEPTH_RE intentionally
    // narrows to the historical-state phrasing so it doesn't capture this
    // case; BLOCK_NOT_AVAILABLE_RE includes the bare phrase so it lands in
    // the retry-then-latest branch where it belongs.
    let primaryCallNo = 0;
    const primary = mockClient(async (args) => {
      primaryCallNo++;
      if (args.blockNumber !== undefined) {
        throw new Error("Block requested not found");
      }
      return "latest-result";
    });
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      100n,
      null,
    );
    assert.equal(res.result, "latest-result");
    assert.equal(
      res.usedLatestFallback,
      true,
      "bare phrase routes to BLOCK_NOT_AVAILABLE_RE retry-then-latest path",
    );
    // 1 initial + 3 retries with blockNumber + 1 latest = 5
    assert.equal(primaryCallNo, 5, "retry loop fires for transient-lag path");
  });

  it("post-rate-limit-retry block-miss: throws fail-closed (does NOT route to retry-then-latest)", async () => {
    // The previous fix routed retry-surfaced non-rate-limit errors through
    // the archive-depth / block-not-available branches. That was correct
    // for archive-depth (the secondary CAN serve the same block) but wrong
    // for block-not-available — historical callers like fetchNumReporters,
    // fetchReportExpiry, and fetchTradingLimits don't check
    // usedLatestFallback, so silently degrading to current-block data after
    // a 429-then-block-miss would corrupt their entity state. Pin
    // fail-closed for the post-retry block-miss shape.
    let primaryCallNo = 0;
    const primary = mockClient(async () => {
      primaryCallNo++;
      if (primaryCallNo === 1) throw new Error("rate limit");
      throw new Error("header not found"); // block-miss after retry
    });
    await assert.rejects(
      readContractWithBlockFallback(
        TEST_CHAIN_ID,
        primary,
        baseArgs,
        100n,
        null,
      ),
      /header not found/,
      "post-rate-limit-retry block-miss must throw — caller's try/catch returns null",
    );
  });

  it("post-rate-limit-retry archive-depth: still routes to secondary (regression guard)", async () => {
    // Companion to the test above: archive-depth surfacing after a
    // rate-limit retry MUST still hit the same-block secondary fallback,
    // because that's the only way to preserve block-scoped accuracy.
    let primaryCallNo = 0;
    const primary = mockClient(async () => {
      primaryCallNo++;
      if (primaryCallNo === 1) throw new Error("rate limit");
      throw new Error("querying historical state");
    });
    const fallback = mockClient(async () => "secondary-block-scoped");
    const res = await readContractWithBlockFallback(
      TEST_CHAIN_ID,
      primary,
      baseArgs,
      100n,
      fallback,
    );
    assert.equal(res.result, "secondary-block-scoped");
    assert.equal(res.usedFallback, true);
    assert.equal(res.usedLatestFallback, false);
  });
});

// ---------------------------------------------------------------------------
// Block-depth-aware rate-limit fallback
// ---------------------------------------------------------------------------

describe("rate-limit fallback skips secondary below known archive horizon", () => {
  const baseArgs = {
    address: "0xtest",
    abi: [],
    functionName: "foo",
  };
  const HORIZON_CHAIN = 999_777;

  let originalDelayFn: typeof _testHooks.delayFn;
  let originalNowFn: typeof _testHooks.nowFn;
  beforeAll(() => {
    originalDelayFn = _testHooks.delayFn;
    originalNowFn = _testHooks.nowFn;
    _testHooks.delayFn = async () => {};
    _testHooks.nowFn = () => 0;
  });
  afterAll(() => {
    _testHooks.delayFn = originalDelayFn;
    _testHooks.nowFn = originalNowFn;
  });

  beforeEach(() => {
    _resetFallbackArchiveDepth();
    _testHooks.resetFallbackRuntimeState();
  });

  it("first archive-depth fallback failure records the horizon", async () => {
    const primary = mockClient(async () => {
      throw new Error("querying historical state");
    });
    const fallback = mockClient(async () => {
      throw new Error(
        "Invalid parameters were provided to the RPC method. Double check you have provided the correct parameters.",
      );
    });
    await assert.rejects(() =>
      readContractWithBlockFallback(
        HORIZON_CHAIN,
        primary,
        baseArgs,
        500n,
        fallback,
      ),
    );
    // Horizon now records 500 — a deeper block (200) should be considered
    // "lacks coverage" while a newer block (600) should not.
    assert.equal(fallbackLikelyHasBlock(HORIZON_CHAIN, 200n), false);
    assert.equal(fallbackLikelyHasBlock(HORIZON_CHAIN, 500n), false);
    assert.equal(fallbackLikelyHasBlock(HORIZON_CHAIN, 600n), true);
  });

  it("rate-limit on a block below the recorded horizon skips the fallback entirely", async () => {
    // Pre-seed the horizon at block 500.
    recordFallbackArchiveMiss(HORIZON_CHAIN, 500n);

    let fallbackCalls = 0;
    const primary = mockClient(async () => {
      throw new Error("rate limit");
    });
    const fallback = mockClient(async () => {
      fallbackCalls++;
      return "should-not-reach-here";
    });

    // Block 200 is below the horizon → fallback must NOT be called.
    await assert.rejects(
      () =>
        readContractWithBlockFallback(
          HORIZON_CHAIN,
          primary,
          baseArgs,
          200n,
          fallback,
        ),
      /rate limit/,
      "rate-limit error must propagate when fallback is gated",
    );
    assert.equal(
      fallbackCalls,
      0,
      "fallback must not be called for blocks below horizon",
    );
  });

  it("rate-limit on a block above the horizon still uses the fallback", async () => {
    recordFallbackArchiveMiss(HORIZON_CHAIN, 500n);

    let fallbackCalls = 0;
    const primary = mockClient(async () => {
      throw new Error("rate limit");
    });
    const fallback = mockClient(async () => {
      fallbackCalls++;
      return "secondary-served";
    });

    const res = await readContractWithBlockFallback(
      HORIZON_CHAIN,
      primary,
      baseArgs,
      900n,
      fallback,
    );
    assert.equal(res.result, "secondary-served");
    assert.equal(res.usedFallback, true);
    assert.equal(fallbackCalls, 1);
  });

  it("rate-limit fallback that fails archive-depth records a deeper horizon", async () => {
    // Start at horizon 300; a fallback call at block 700 fails archive-
    // depth → horizon should bump to 700.
    recordFallbackArchiveMiss(HORIZON_CHAIN, 300n);

    const primary = mockClient(async () => {
      throw new Error("rate limit");
    });
    const fallback = mockClient(async () => {
      throw new Error(
        "Invalid parameters were provided to the RPC method. Double check you have provided the correct parameters.",
      );
    });

    await assert.rejects(() =>
      readContractWithBlockFallback(
        HORIZON_CHAIN,
        primary,
        baseArgs,
        700n,
        fallback,
      ),
    );
    assert.equal(fallbackLikelyHasBlock(HORIZON_CHAIN, 700n), false);
    // 800 is above the new 700 horizon — should be "likely has".
    assert.equal(fallbackLikelyHasBlock(HORIZON_CHAIN, 800n), true);
  });

  it("undefined blockNumber always passes the gate (latest reads)", () => {
    recordFallbackArchiveMiss(HORIZON_CHAIN, 1_000_000n);
    assert.equal(fallbackLikelyHasBlock(HORIZON_CHAIN, undefined), true);
  });

  it("recordFallbackArchiveMiss does not reduce an already-higher horizon", () => {
    // Higher block first, lower block after — second call must be a no-op
    // so the horizon only ever moves toward head, never backwards. Without
    // this invariant, two concurrent rate-limit fallbacks ordering reverse
    // could shrink the horizon and re-admit blocks the secondary already
    // told us it can't serve.
    recordFallbackArchiveMiss(HORIZON_CHAIN, 800n);
    recordFallbackArchiveMiss(HORIZON_CHAIN, 300n);
    assert.equal(
      fallbackLikelyHasBlock(HORIZON_CHAIN, 500n),
      false,
      "block above the discarded 300 floor but below the 800 horizon must still be gated",
    );
    assert.equal(fallbackLikelyHasBlock(HORIZON_CHAIN, 900n), true);
  });
});
