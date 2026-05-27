import assert from "node:assert/strict";
import {
  computeCooldownEndsAt,
  effectiveCooldown,
  effectiveThreshold,
  nextMedianEMA,
  resolveBreakerSnapshotFields,
} from "../src/breakers.ts";
import {
  _clearBreakerKindIndex,
  getContractAddress,
} from "../src/contractAddresses.ts";
import {
  _clearBreakerMocks,
  _clearRpcClients,
  _setRpcClientForTests,
  _testHooks,
  fetchBreakerKind,
} from "../src/rpc.ts";

const FIXED_1 = 10n ** 24n;
const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("nextMedianEMA — Fixidity formula mirroring MedianDeltaBreaker.shouldTrigger", () => {
  it("seeds EMA with currentMedian when previousEMA is 0 (contract line 182-186)", () => {
    const currentMedian = 1_171_560_280_196_965_000_000_000n; // 1.171… Fixidity
    const result = nextMedianEMA(currentMedian, 0n, 5n * 10n ** 21n /* 0.5% */);
    assert.equal(result, currentMedian);
  });

  it("seeds with currentMedian even if smoothingFactor is 0 (default-smoothing branch)", () => {
    // Smoothing 0 falls back to fixed1 (1e24) inside the helper; with EMA 0,
    // the seed branch fires regardless of smoothing.
    const currentMedian = 12345n;
    assert.equal(nextMedianEMA(currentMedian, 0n, 0n), 12345n);
  });

  it("blends current median into EMA at the configured smoothing weight", () => {
    // With smoothing 0.5% (production value), 99.5% old + 0.5% new.
    const sf = 5n * 10n ** 21n; // 0.5% Fixidity
    const previous = 1_000_000n * FIXED_1; // arbitrary EMA
    const next = 1_010_000n * FIXED_1; // 1% jump
    const result = nextMedianEMA(next, previous, sf);
    // Expected: (1_010_000 * 0.005 + 1_000_000 * 0.995) * FIXED_1
    //         = (5050 + 995_000) * FIXED_1
    //         = 1_000_050 * FIXED_1
    assert.equal(result, 1_000_050n * FIXED_1);
  });

  it("treats smoothing factor 1.0 as 'replace EMA with currentMedian'", () => {
    const sf = FIXED_1; // 100% weight on new sample
    const previous = 100n;
    const current = 200n;
    assert.equal(nextMedianEMA(current, previous, sf), 200n);
  });
});

describe("computeCooldownEndsAt", () => {
  it("returns 0 when cooldown is 0 (manual reset only)", () => {
    assert.equal(computeCooldownEndsAt(123n, 0n), 0n);
  });

  it("returns lastStatusUpdatedAt + cooldownTime", () => {
    assert.equal(computeCooldownEndsAt(1_700_000_000n, 900n), 1_700_000_900n);
  });
});

describe("effectiveCooldown / effectiveThreshold — sentinel-0 inheritance", () => {
  const breaker = {
    defaultCooldownTime: 900n,
    defaultRateChangeThreshold: 4n * 10n ** 22n, // 4%
  };

  it("uses per-feed override when > 0", () => {
    assert.equal(effectiveCooldown(breaker, 60n), 60n);
  });

  it("falls back to default when per-feed is 0", () => {
    assert.equal(effectiveCooldown(breaker, 0n), 900n);
  });

  it("threshold inherits the same way", () => {
    assert.equal(effectiveThreshold(breaker, 0n), 4n * 10n ** 22n);
    assert.equal(effectiveThreshold(breaker, 1n * 10n ** 22n), 1n * 10n ** 22n);
  });
});

describe("resolveBreakerSnapshotFields — per-snapshot breaker baseline + threshold", () => {
  const CHAIN_ID = 42220;
  const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";

  // Construct a minimal EvmOnEventContext stub exposing only the entity
  // reads the resolver uses. Tests are pure (no RPC, no effects), so we
  // skip the test harness and exercise the helper directly. Envio's
  // `getWhere` is a callable taking a `{ field: { _eq } }` filter and
  // returning a Promise<Entity[]> (per envio.d.ts) — the stub mirrors
  // that shape so the implementation can be swapped to the real API
  // without changing the helper's call sites.
  function ctx({
    configs = [],
    breakers = {},
  }: {
    configs?: Array<Record<string, unknown>>;
    breakers?: Record<string, Record<string, unknown>>;
  }) {
    return {
      BreakerConfig: {
        getWhere: async (filter: { rateFeedID: { _eq: string } }) =>
          configs.filter((c) => c.rateFeedID === filter.rateFeedID._eq),
      },
      Breaker: {
        get: async (id: string) => breakers[id],
      },
    } as unknown as Parameters<typeof resolveBreakerSnapshotFields>[0];
  }

  it("returns MEDIAN_DELTA EMA + effective threshold", async () => {
    const ema = 1_171_560_280_196_965_000_000_000n; // 1.171… Fixidity
    const perFeedThreshold = 3n * 10n ** 22n; // 3% override
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `${CHAIN_ID}-0xbreaker-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `${CHAIN_ID}-0xbreaker`,
            rateChangeThreshold: perFeedThreshold,
            medianRatesEMA: ema,
            referenceValue: undefined,
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xbreaker`]: {
            kind: "MEDIAN_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n, // 4% — not used
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.deepStrictEqual(result, {
      breakerBaselineAtSnapshot: ema,
      breakerThresholdAtSnapshot: perFeedThreshold, // override beats default
    });
  });

  it("falls back to breaker default threshold when per-feed is sentinel 0", async () => {
    // Mirrors the canonical `effectiveThreshold` resolution; the helper
    // must apply it here so consumers can render the band without
    // re-resolving the sentinel themselves.
    const ema = 10n ** 24n;
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `${CHAIN_ID}-0xbreaker-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `${CHAIN_ID}-0xbreaker`,
            rateChangeThreshold: 0n, // sentinel — inherit
            medianRatesEMA: ema,
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xbreaker`]: {
            kind: "MEDIAN_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n,
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.equal(result?.breakerThresholdAtSnapshot, 4n * 10n ** 22n);
  });

  it("uses referenceValue for VALUE_DELTA configs", async () => {
    const peg = (10n ** 24n * 998n) / 1000n; // 0.998 reference
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `${CHAIN_ID}-0xvalue-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `${CHAIN_ID}-0xvalue`,
            rateChangeThreshold: 2n * 10n ** 22n,
            medianRatesEMA: undefined,
            referenceValue: peg,
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xvalue`]: {
            kind: "VALUE_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n,
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.equal(result?.breakerBaselineAtSnapshot, peg);
  });

  it("returns null when MEDIAN_DELTA EMA is the unseeded 0n sentinel", async () => {
    // Writing 0n as a baseline would produce NaN/Inf in the chart's
    // verdict math (|p - 0|/0). Force-null + fall back to "no band".
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `${CHAIN_ID}-0xbreaker-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `${CHAIN_ID}-0xbreaker`,
            rateChangeThreshold: 3n * 10n ** 22n,
            medianRatesEMA: 0n, // unseeded after MedianRateEMAReset
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xbreaker`]: {
            kind: "MEDIAN_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n,
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.equal(result, null);
  });

  it("returns null when VALUE_DELTA referenceValue is missing", async () => {
    // Less common but symmetric: a VALUE_DELTA without a configured peg
    // has no comparator either — chart falls through to "no band check."
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `${CHAIN_ID}-0xvalue-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `${CHAIN_ID}-0xvalue`,
            rateChangeThreshold: 2n * 10n ** 22n,
            referenceValue: undefined,
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xvalue`]: {
            kind: "VALUE_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n,
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.equal(result, null);
  });

  it("skips disabled configs", async () => {
    // Match dashboard's BREAKER_CONFIG_FOR_RATE_FEED `enabled: true` filter.
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `${CHAIN_ID}-0xbreaker-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: false,
            breaker_id: `${CHAIN_ID}-0xbreaker`,
            rateChangeThreshold: 3n * 10n ** 22n,
            medianRatesEMA: 10n ** 24n,
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xbreaker`]: {
            kind: "MEDIAN_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n,
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.equal(result, null);
  });

  it("skips MARKET_HOURS breakers (schedule halt, no per-feed comparator)", async () => {
    // MarketHoursBreaker has no BreakerConfig in production (per schema
    // comment); even if a config somehow joined to it, MARKET_HOURS isn't
    // a deviation comparator — the chart's band check would be meaningless.
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `${CHAIN_ID}-0xmh-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `${CHAIN_ID}-0xmh`,
            rateChangeThreshold: 0n,
            medianRatesEMA: 10n ** 24n,
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xmh`]: {
            kind: "MARKET_HOURS",
            defaultRateChangeThreshold: 0n,
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.equal(result, null);
  });

  it("filters by chainId in memory (same rateFeedID can exist on multiple chains)", async () => {
    // `BreakerConfig.getWhere({rateFeedID})` doesn't filter by chainId —
    // the same feed string can collide cross-chain on Celo + Monad.
    // Helper must filter in memory or it can mix Monad's EMA into a Celo
    // snapshot.
    const celoEma = 10n ** 24n;
    const monadEma = 5n * 10n ** 23n;
    const result = await resolveBreakerSnapshotFields(
      ctx({
        configs: [
          {
            id: `143-0xbreaker-${FEED}`,
            chainId: 143,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `143-0xbreaker`,
            rateChangeThreshold: 3n * 10n ** 22n,
            medianRatesEMA: monadEma,
          },
          {
            id: `${CHAIN_ID}-0xbreaker-${FEED}`,
            chainId: CHAIN_ID,
            rateFeedID: FEED,
            enabled: true,
            breaker_id: `${CHAIN_ID}-0xbreaker`,
            rateChangeThreshold: 3n * 10n ** 22n,
            medianRatesEMA: celoEma,
          },
        ],
        breakers: {
          [`${CHAIN_ID}-0xbreaker`]: {
            kind: "MEDIAN_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n,
          },
          [`143-0xbreaker`]: {
            kind: "MEDIAN_DELTA",
            defaultRateChangeThreshold: 4n * 10n ** 22n,
          },
        },
      }),
      CHAIN_ID,
      FEED,
    );
    assert.equal(result?.breakerBaselineAtSnapshot, celoEma);
  });
});

describe("fetchBreakerKind RPC selector probes", () => {
  const CHAIN_ID = 42220;
  const BREAKER = "0x00000000000000000000000000000000000000bb";
  let originalDelayFn: typeof _testHooks.delayFn;

  beforeAll(() => {
    originalDelayFn = _testHooks.delayFn;
    _testHooks.delayFn = async () => {};
  });

  afterAll(() => {
    _testHooks.delayFn = originalDelayFn;
  });

  afterEach(() => {
    _setRpcClientForTests(CHAIN_ID, null);
    _setRpcClientForTests(143, null);
    _clearRpcClients();
    _clearBreakerMocks();
    _clearBreakerKindIndex();
  });

  it("uses package metadata for known breaker kinds before selector probes", async () => {
    const calls: unknown[] = [];
    _setRpcClientForTests(143, {
      readContract: async (args) => {
        calls.push(args);
        throw new Error("selector probe should not run for known breakers");
      },
    });

    const valueDelta = getContractAddress(143, "ValueDeltaBreaker");
    const marketHours = getContractAddress(143, "MarketHoursBreakerv300");

    assert.ok(valueDelta);
    assert.ok(marketHours);
    assert.equal(
      await fetchBreakerKind(143, valueDelta, noopLogger),
      "VALUE_DELTA",
    );
    assert.equal(
      await fetchBreakerKind(143, marketHours, noopLogger),
      "MARKET_HOURS",
    );
    assert.equal(calls.length, 0);
  });

  it("retries rate-limited selector probes through readContractWithBlockFallback", async () => {
    const calls: unknown[] = [];
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        calls.push(args);
        if (calls.length === 1) {
          throw new Error("rate limit exceeded");
        }
        return 0n;
      },
    });

    const kind = await fetchBreakerKind(CHAIN_ID, BREAKER, noopLogger);

    assert.equal(kind, "MEDIAN_DELTA");
    assert.equal(calls.length, 2);
    assert.equal(
      (calls[0] as { functionName: string }).functionName,
      "medianRatesEMA",
    );
    assert.equal(
      (calls[1] as { functionName: string }).functionName,
      "medianRatesEMA",
    );
  });

  it("still treats selector zero-data responses as missing functions", async () => {
    const functionNames: string[] = [];
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        functionNames.push((args as { functionName: string }).functionName);
        throw new Error('The contract function "x" returned no data ("0x").');
      },
    });

    const kind = await fetchBreakerKind(CHAIN_ID, BREAKER, noopLogger);

    assert.equal(kind, "MARKET_HOURS");
    assert.deepEqual(functionNames, ["medianRatesEMA", "referenceValues"]);
  });

  // Construct a viem-shaped error: the production heuristic keys on
  // `err.name === "ContractFunctionExecutionError"` and the `shortMessage`
  // property. Tests that throw bare `Error` would skip that branch.
  function viemExecError(shortMessage: string): Error {
    const err = new Error(`${shortMessage}\n\nContract Call:\n  …`);
    err.name = "ContractFunctionExecutionError";
    (err as unknown as { shortMessage: string }).shortMessage = shortMessage;
    return err;
  }

  it("treats viem's bare 'reverted.' dispatcher revert as a selector miss", async () => {
    // Production reality (verified against forno.celo.org + viem 2.x): when
    // a modern Solidity contract is called with a selector not in its
    // dispatcher, viem throws `ContractFunctionExecutionError` whose
    // shortMessage is `The contract function "X" reverted.` — there is no
    // "returned no data" substring. Without this branch the probe would
    // classify every live MD/VD/MH breaker probe as a transient RPC error
    // and `fetchBreakerKind` would return null for every unknown breaker.
    const functionNames: string[] = [];
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const fn = (args as { functionName: string }).functionName;
        functionNames.push(fn);
        throw viemExecError(`The contract function "${fn}" reverted.`);
      },
    });

    const kind = await fetchBreakerKind(CHAIN_ID, BREAKER, noopLogger);

    assert.equal(kind, "MARKET_HOURS");
    assert.deepEqual(functionNames, ["medianRatesEMA", "referenceValues"]);
  });

  it("classifies 'reverted with the following reason: ...' as rpc_error, not missing", async () => {
    // A live require() failure inside the function body MUST NOT be misread
    // as a missing selector. The MD breaker's `shouldTrigger` reverts with
    // "Caller must be the BreakerBox contract" when probed from a non-BB
    // address — that's a function-exists-but-failed signal. Returning null
    // here lets the next event retry; returning "MARKET_HOURS" would lock
    // in the wrong kind for the rest of the indexer's life.
    const calls: { fn: string }[] = [];
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const fn = (args as { functionName: string }).functionName;
        calls.push({ fn });
        throw viemExecError(
          `The contract function "${fn}" reverted with the following reason: Caller must be the BreakerBox contract.`,
        );
      },
    });

    const kind = await fetchBreakerKind(CHAIN_ID, BREAKER, noopLogger);

    assert.equal(kind, null);
    // Probe order halts at the first rpc_error (MD probe).
    assert.deepEqual(
      calls.map((c) => c.fn),
      ["medianRatesEMA"],
    );
  });

  it("classifies a custom-error revert as rpc_error, not missing", async () => {
    // Future-proofs the heuristic against probe targets that use typed
    // custom errors. viem formats those as:
    //   `…reverted with the following signature: 0x12345678`
    //   `…reverted with custom error '0x…'`
    // Neither ends with `reverted.`, so the suffix-anchored check below
    // routes them to rpc_error (function-exists-but-failed) rather than
    // misclassifying the call as a missing selector and pinning a
    // permanent MARKET_HOURS.
    const calls: { fn: string }[] = [];
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async (args) => {
        const fn = (args as { functionName: string }).functionName;
        calls.push({ fn });
        throw viemExecError(
          `The contract function "${fn}" reverted with the following signature:\n0xdeadbeef\n\nUnable to decode signature "0xdeadbeef" as it was not found on the provided ABI.`,
        );
      },
    });

    const kind = await fetchBreakerKind(CHAIN_ID, BREAKER, noopLogger);

    assert.equal(kind, null);
    assert.deepEqual(
      calls.map((c) => c.fn),
      ["medianRatesEMA"],
    );
  });

  it("emits a structured warn when defaulting an unknown breaker to MARKET_HOURS", async () => {
    const warnings: string[] = [];
    const spyLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => undefined,
    };
    _setRpcClientForTests(CHAIN_ID, {
      readContract: async () => {
        throw new Error('The contract function "x" returned no data ("0x").');
      },
    });

    const kind = await fetchBreakerKind(CHAIN_ID, BREAKER, spyLogger);

    assert.equal(kind, "MARKET_HOURS");
    const match = warnings.find((w) =>
      w.startsWith("breakers.fetchBreakerKind.market_hours_default"),
    );
    assert.ok(
      match,
      `expected a warn with prefix breakers.fetchBreakerKind.market_hours_default, got: ${JSON.stringify(warnings)}`,
    );
  });
});
