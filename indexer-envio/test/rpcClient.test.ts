import { strict as assert } from "assert";
import { getRpcClient, _clearRpcClients, _testHooks } from "../src/rpc.js";
import { getFallbackRpcClient } from "../src/rpc/client.js";

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
  "ENVIO_RPC_FALLBACK_URL_42220",
  "ENVIO_RPC_FALLBACK_URL_11142220",
  "ENVIO_RPC_FALLBACK_URL_143",
  "ENVIO_RPC_FALLBACK_URL_10143",
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

function clearRpcEnv(): void {
  for (const k of ENV_KEYS) {
    delete process.env[k];
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
    clearRpcEnv();
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
    ["125/second request limit reached", true], // QuickNode
    ["too many requests", true],
    ["429 Too Many Requests", true],
    ["throttled by provider", true],
    ["throttle: backoff and retry", true],
    ["Request exceeds defined limit.", true], // rpc2.monad.xyz
    ["Request exceeds defined limit", true],
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

// ---------------------------------------------------------------------------
// getFallbackRpcClient
// ---------------------------------------------------------------------------

describe("getFallbackRpcClient", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    clearRpcEnv();
    _clearRpcClients();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    _clearRpcClients();
  });

  it("returns null when primary uses the hardcoded default and no fallback override is set", () => {
    delete process.env.ENVIO_RPC_URL_143;
    delete process.env.ENVIO_RPC_FALLBACK_URL_143;
    assert.equal(getFallbackRpcClient(143), null);
  });

  it("returns a client when primary is overridden and the fallback differs from primary", () => {
    // Mirrors today's prod state: primary = QuickNode override, fallback =
    // hardcoded rpc2.monad.xyz.
    process.env.ENVIO_RPC_URL_143 = "https://example.quiknode.pro/auth-token/";
    delete process.env.ENVIO_RPC_FALLBACK_URL_143;
    assert.ok(getFallbackRpcClient(143));
  });

  it("uses ENVIO_RPC_FALLBACK_URL_<chainId> override when set", () => {
    // Swap: primary = default (rpc2), fallback = explicit override (e.g.
    // QuickNode). With the old code path this would have returned null
    // because primary == default; the new code path must return a client.
    delete process.env.ENVIO_RPC_URL_143;
    process.env.ENVIO_RPC_FALLBACK_URL_143 =
      "https://example.quiknode.pro/auth-token/";
    assert.ok(getFallbackRpcClient(143));
  });

  it("returns null when the fallback override resolves to the same URL as primary", () => {
    process.env.ENVIO_RPC_URL_143 = "https://same.example.org/";
    process.env.ENVIO_RPC_FALLBACK_URL_143 = "https://same.example.org/";
    assert.equal(getFallbackRpcClient(143), null);
  });

  it("normalizes trailing-slash differences when comparing primary and fallback URLs", () => {
    // Without `URL.href` normalization, `"https://x"` !== `"https://x/"` and
    // we'd spin up a useless self-referencing fallback client.
    process.env.ENVIO_RPC_URL_143 = "https://same.example.org";
    process.env.ENVIO_RPC_FALLBACK_URL_143 = "https://same.example.org/";
    assert.equal(getFallbackRpcClient(143), null);
  });

  it("treats an empty ENVIO_RPC_FALLBACK_URL_<chainId> as unset", () => {
    // Hosted secret platforms sometimes surface blank values; falling
    // through to `http("")` would crash with UrlRequiredError. Behaviour
    // must match "unset entirely": fall back to the hardcoded default,
    // which (for chain 143) equals the primary when ENVIO_RPC_URL_143 is
    // also unset → null fallback.
    delete process.env.ENVIO_RPC_URL_143;
    process.env.ENVIO_RPC_FALLBACK_URL_143 = "";
    assert.equal(getFallbackRpcClient(143), null);
  });

  it("treats an empty ENVIO_RPC_URL_<chainId> as unset when resolving primary for the same-URL guard", () => {
    // getRpcClient uses truthiness; getFallbackRpcClient must agree. If we
    // used `??` and ENVIO_RPC_URL_143 = "", primaryUrl would be "" while
    // the actual primary is config.default ("https://rpc2.monad.xyz") — the
    // sameUrl check would miss and we'd return a self-referencing fallback
    // client at config.default.
    process.env.ENVIO_RPC_URL_143 = "";
    delete process.env.ENVIO_RPC_FALLBACK_URL_143;
    assert.equal(getFallbackRpcClient(143), null);
  });

  it("returns null for an unknown chainId", () => {
    assert.equal(getFallbackRpcClient(999999), null);
  });

  it("caches the fallback client across calls (same chainId)", () => {
    process.env.ENVIO_RPC_URL_143 = "https://example.quiknode.pro/auth-token/";
    const a = getFallbackRpcClient(143);
    const b = getFallbackRpcClient(143);
    assert.ok(a);
    assert.equal(a, b);
  });

  it("returns null when the resolved fallback URL is a bare HyperRPC endpoint", () => {
    // Force resolution to a bare HyperRPC URL via the override; without a
    // token we can't safely fall back to it (HyperRPC requires path-segment
    // auth, and the call would fail with eth_call unsupported anyway).
    delete process.env.ENVIO_API_TOKEN;
    process.env.ENVIO_RPC_URL_143 = "https://example.org/celo";
    process.env.ENVIO_RPC_FALLBACK_URL_143 = "https://10143.rpc.hypersync.xyz/";
    assert.equal(getFallbackRpcClient(143), null);
  });
});
