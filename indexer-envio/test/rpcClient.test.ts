/// <reference types="mocha" />
import { strict as assert } from "assert";
import { getRpcClient, _clearRpcClients, _testHooks } from "../src/rpc";

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "ENVIO_API_TOKEN",
  "ENVIO_RPC_URL",
  "ENVIO_RPC_URL_42220",
  "ENVIO_RPC_URL_11142220",
  "ENVIO_RPC_URL_143",
  "ENVIO_RPC_URL_10143",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// ---------------------------------------------------------------------------
// console capture
// ---------------------------------------------------------------------------

function captureConsole(): {
  warn: string[];
  debug: string[];
  restore: () => void;
} {
  const warn: string[] = [];
  const debug: string[] = [];
  const origWarn = console.warn;
  const origDebug = console.debug;
  console.warn = (...args: unknown[]) => {
    warn.push(args.map((a) => String(a)).join(" "));
  };
  console.debug = (...args: unknown[]) => {
    debug.push(args.map((a) => String(a)).join(" "));
  };
  return {
    warn,
    debug,
    restore: () => {
      console.warn = origWarn;
      console.debug = origDebug;
    },
  };
}

// ---------------------------------------------------------------------------
// getRpcClient
// ---------------------------------------------------------------------------

describe("getRpcClient", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    _clearRpcClients();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    _clearRpcClients();
  });

  // Bare-HyperRPC fail-fast + token-paired success paths are pinned by
  // hyperRpcToken.test.ts; the cases below cover ground that file does not.

  it("throws for an unknown chainId not in RPC_CONFIG_BY_CHAIN", () => {
    assert.throws(
      () => getRpcClient(999999),
      /No RPC config for chainId 999999/,
    );
  });

  it("returns a client when a non-HyperRPC override is set without a token", () => {
    delete process.env.ENVIO_API_TOKEN;
    process.env.ENVIO_RPC_URL_42220 = "https://example.org/celo";
    const client = getRpcClient(42220);
    assert.ok(client);
  });

  it("caches the client across calls (same chainId)", () => {
    delete process.env.ENVIO_API_TOKEN;
    process.env.ENVIO_RPC_URL_42220 = "https://example.org/celo";
    const a = getRpcClient(42220);
    const b = getRpcClient(42220);
    assert.equal(a, b, "same instance must be returned for cached chainId");
  });

  it("warns when falling back to the legacy single-chain ENVIO_RPC_URL", () => {
    delete process.env.ENVIO_API_TOKEN;
    delete process.env.ENVIO_RPC_URL_42220;
    process.env.ENVIO_RPC_URL = "https://legacy.example.org";
    const cap = captureConsole();
    try {
      getRpcClient(42220);
    } finally {
      cap.restore();
    }
    assert.ok(
      cap.warn.some((line) => line.includes("legacy ENVIO_RPC_URL fallback")),
      `expected legacy-fallback warn line; got: ${JSON.stringify(cap.warn)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// isRateLimitError
// ---------------------------------------------------------------------------

describe("isRateLimitError", () => {
  const cases: Array<[string, boolean]> = [
    ["rate limit exceeded", true],
    ["Rate Limit Exceeded", true],
    ["request limit reached", true],
    ["too many requests", true],
    ["429 Too Many Requests", true],
    ["throttled by provider", true],
    ["throttle: backoff and retry", true],
    ["execution reverted: OracleStaleOrExpired", false],
    ["network unreachable", false],
    ["timeout while reading block", false],
    ["", false],
  ];

  for (const [msg, expected] of cases) {
    it(`returns ${expected} for "${msg}"`, () => {
      const err = new Error(msg);
      assert.equal(_testHooks.isRateLimitError(err), expected);
    });
  }

  it("returns false for non-Error values", () => {
    assert.equal(_testHooks.isRateLimitError("rate limit"), false);
    assert.equal(_testHooks.isRateLimitError(null), false);
    assert.equal(_testHooks.isRateLimitError(undefined), false);
    assert.equal(_testHooks.isRateLimitError({ message: "rate limit" }), false);
  });
});

// ---------------------------------------------------------------------------
// logRpcFailure
// ---------------------------------------------------------------------------

describe("logRpcFailure", () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
    _testHooks.resetRpcFailureCounts();
  });

  afterEach(() => {
    cap.restore();
  });

  it("emits a single [RPC_FAILURE] warn line for an unknown error", () => {
    _testHooks.logRpcFailure(
      42220,
      "fetchReserves",
      "0xPool",
      new Error("network down"),
    );
    assert.equal(cap.warn.length, 1);
    assert.match(cap.warn[0], /\[RPC_FAILURE\]/);
    assert.match(cap.warn[0], /chainId=42220/);
    assert.match(cap.warn[0], /fn=fetchReserves/);
    assert.match(cap.warn[0], /target=0xPool/);
    assert.match(cap.warn[0], /error=network down/);
    assert.equal(cap.debug.length, 0);
  });

  it("includes block number when supplied", () => {
    _testHooks.logRpcFailure(
      42220,
      "fetchReserves",
      "0xPool",
      new Error("oops"),
      12345n,
    );
    assert.match(cap.warn[0], /block=12345/);
  });

  it("emits a [CONTRACT_REVERT] debug line (not a warn) for OracleStaleOrExpired", () => {
    _testHooks.logRpcFailure(
      42220,
      "getRebalancingState",
      "0xPool",
      new Error("execution reverted with the following signature: 0xa407143a"),
    );
    assert.equal(cap.warn.length, 0);
    assert.equal(cap.debug.length, 1);
    assert.match(cap.debug[0], /\[CONTRACT_REVERT\]/);
    assert.match(cap.debug[0], /OracleStaleOrExpired/);
  });

  it("emits a [RPC_FAILURE_BURST] line every 10 unknown failures (per chain+fn key)", () => {
    for (let i = 0; i < 9; i++) {
      _testHooks.logRpcFailure(
        42220,
        "fetchReserves",
        "0xPool",
        new Error("transient"),
      );
    }
    assert.equal(cap.warn.length, 9);
    assert.ok(!cap.warn.some((l) => l.includes("[RPC_FAILURE_BURST]")));

    _testHooks.logRpcFailure(
      42220,
      "fetchReserves",
      "0xPool",
      new Error("transient"),
    );
    assert.equal(cap.warn.length, 11);
    assert.match(cap.warn[9], /\[RPC_FAILURE\]/);
    assert.match(cap.warn[10], /\[RPC_FAILURE_BURST\]/);
    assert.match(cap.warn[10], /failureCount=10/);

    _testHooks.logRpcFailure(
      42220,
      "fetchReserves",
      "0xPool",
      new Error("transient"),
    );
    assert.equal(cap.warn.length, 12);
    assert.ok(!cap.warn[11].includes("[RPC_FAILURE_BURST]"));
  });

  it("tracks burst counts independently per chainId+fn key", () => {
    for (let i = 0; i < 10; i++) {
      _testHooks.logRpcFailure(42220, "fetchReserves", "0xA", new Error("e"));
    }
    for (let i = 0; i < 10; i++) {
      _testHooks.logRpcFailure(143, "fetchReserves", "0xB", new Error("e"));
    }
    // Different fn on the same chain must not contribute to the original
    // counter.
    for (let i = 0; i < 5; i++) {
      _testHooks.logRpcFailure(42220, "fetchFees", "0xA", new Error("e"));
    }

    const burstLines = cap.warn.filter((l) =>
      l.includes("[RPC_FAILURE_BURST]"),
    );
    assert.equal(burstLines.length, 2);
    assert.ok(burstLines.some((l) => l.includes("chainId=42220")));
    assert.ok(burstLines.some((l) => l.includes("chainId=143")));
    assert.ok(
      !burstLines.some((l) => l.includes("fn=fetchFees")),
      "fetchFees counter at 5 must not have triggered a burst",
    );
  });

  it("uses the [CONTRACT_REVERT_BURST] tag when the burst is composed of known reverts", () => {
    const knownRevert =
      "execution reverted with the following signature: 0xa407143a";
    for (let i = 0; i < 10; i++) {
      _testHooks.logRpcFailure(
        42220,
        "getRebalancingState",
        "0xPool",
        new Error(knownRevert),
      );
    }
    assert.equal(cap.debug.length, 10);
    assert.equal(cap.warn.length, 1);
    assert.match(cap.warn[0], /\[CONTRACT_REVERT_BURST\]/);
  });

  it("redacts URLs in error messages (preserves origin only)", () => {
    _testHooks.logRpcFailure(
      42220,
      "fetchReserves",
      "0xPool",
      new Error(
        "fetch failed for https://secret.example.org/path/with?token=abc123",
      ),
    );
    assert.match(cap.warn[0], /https:\/\/secret\.example\.org\/<redacted>/);
    assert.ok(!cap.warn[0].includes("token=abc123"));
    assert.ok(!cap.warn[0].includes("/path/with"));
  });

  it("handles non-Error throwables without crashing", () => {
    _testHooks.logRpcFailure(42220, "fetchReserves", "0xPool", "raw string");
    _testHooks.logRpcFailure(42220, "fetchReserves", "0xPool", null);
    assert.equal(cap.warn.length, 2);
    assert.match(cap.warn[0], /error=raw string/);
    assert.match(cap.warn[1], /error=unknown error/);
  });
});
