import assert from "node:assert/strict";
import type { BiPoolExchange, Pool } from "envio";
import { describe, it } from "vitest";
import { upsertPool } from "../src/pool.ts";
import type { PoolContext } from "../src/pool/types.ts";
import {
  feesEffect,
  invertRateFeedEffect,
  numReportersEffect,
  poolExchangeEffect,
  referenceRateFeedIDEffect,
  reportExpiryEffect,
  tokenDecimalsScalingEffect,
  vpExchangeIdEffect,
} from "../src/rpc/effects.ts";
import { makePool } from "./helpers/makePool.ts";
import { makePoolId } from "../src/helpers.ts";
import type { PoolUpdateSource } from "../src/pool/sources.ts";

// ---------------------------------------------------------------------------
// Issue #1053 scenario 2 — `upsertPool` heal-stage characterization.
//
// Goal: pin the CURRENT per-field output of each self-heal stage inside
// `upsertPool` so the planned decomposition (issue #1056) can diff its
// refactored output against these fixtures and prove behavior-preservation.
//
// Style: call `upsertPool` directly (like the existing `upsertPool breaker
// halt` / `upsertPool degenerate reserves` describe blocks in pool.test.ts)
// with a hand-built `PoolContext` rather than the MockDb harness — this lets
// each test isolate exactly one heal stage by fully controlling every
// `context.effect` response, and the "keep reserves at 0/0, oraclePrice at
// 0n" fixture shape reliably routes `upsertPool` through its early-return
// "frozen priceDifference, skip breach pipeline" branch. That keeps every
// field OTHER than the stage under test byte-for-byte predictable without
// hand-reimplementing the breach/health pipeline in the test.
// ---------------------------------------------------------------------------

const CHAIN_ID = 42220;
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const CONSTANT_SUM_MAINNET = "0xdebed1f6f6ce9f6e73aa25f95acbffe2397550fb";

type EffectOverride = readonly [unknown, (input: never) => unknown];

/** Route `context.effect` calls by the effect definition's identity. Any
 * stage not explicitly overridden gets a safe "already healed / not
 * applicable" default so it never fires — unexpected calls throw instead of
 * silently returning something misleading. */
function routedEffect(
  overrides: readonly EffectOverride[],
): PoolContext["effect"] {
  const table = new Map<unknown, (input: never) => unknown>(overrides);
  return (async (effectDef: unknown, input: never) => {
    const handler = table.get(effectDef);
    if (handler) return handler(input);
    if (effectDef === vpExchangeIdEffect) return null;
    if (effectDef === invertRateFeedEffect) return -1;
    if (effectDef === tokenDecimalsScalingEffect) return null;
    if (effectDef === referenceRateFeedIDEffect) return null;
    if (effectDef === reportExpiryEffect) return null;
    if (effectDef === feesEffect) return null;
    if (effectDef === poolExchangeEffect) return null;
    if (effectDef === numReportersEffect) return 2;
    throw new Error(
      `upsertPoolStages test: unmocked effect invoked (${String(effectDef)})`,
    );
  }) as PoolContext["effect"];
}

function makeContext(effect: PoolContext["effect"]): {
  context: PoolContext;
  writtenPools: Pool[];
  writtenExchanges: BiPoolExchange[];
} {
  const writtenPools: Pool[] = [];
  const writtenExchanges: BiPoolExchange[] = [];
  const context = {
    effect,
    Pool: {
      get: async () => undefined,
      set: (entity: Pool) => writtenPools.push(entity),
    },
    DeviationThresholdBreach: {
      get: async () => undefined,
      set: () => undefined,
    },
    BiPoolExchange: {
      get: async () => undefined,
      set: (entity: BiPoolExchange) => writtenExchanges.push(entity),
    },
    BreakerConfig: { getWhere: async () => [] },
    Breaker: { get: async () => ({ id: "b", kind: "MEDIAN_DELTA" }) },
    RateFeedDependency: { getWhere: async () => [] },
  } as unknown as PoolContext;
  return { context, writtenPools, writtenExchanges };
}

/** Baseline FPMM pool fixture that routes `upsertPool` through its
 * early-return "frozen priceDifference" branch: `oraclePrice` stays at the
 * schema default 0n (so `canRecompute` is false) and reserves are 0/0 (so
 * `classifyExactZeroReserves` deterministically classifies non-degenerate).
 * With no `oracleDelta` passed either, `priceDifferenceTrustworthy` is
 * false and `upsertPool` returns immediately after the heal pipeline —
 * healthStatus/breach fields are never touched, so every field not
 * overridden here is provably stable across stage tests. */
function baselinePool(overrides: Partial<Pool> = {}): Pool {
  return makePool({
    id: makePoolId(CHAIN_ID, "0x00000000000000000000000000000000000abc"),
    chainId: CHAIN_ID,
    source: "fpmm_factory",
    reserves0: 0n,
    reserves1: 0n,
    oraclePrice: 0n,
    oracleOk: false,
    hasHealthData: false,
    invertRateFeedKnown: true,
    invertRateFeed: false,
    tokenDecimalsKnown: true,
    token0Decimals: 18,
    token1Decimals: 18,
    wrappedExchangeId: "",
    referenceRateFeedID: FEED,
    oracleFreshnessWindow: 3_600n,
    oracleNumReporters: 4,
    breakerTripped: false,
    lpFee: 10,
    protocolFee: 5,
    rebalanceReward: 2,
    createdAtBlock: 5n,
    createdAtTimestamp: 1_699_999_000n,
    updatedAtBlock: 5n,
    updatedAtTimestamp: 1_699_999_000n,
    ...overrides,
  });
}

async function runUpsert(
  context: PoolContext,
  existing: Pool,
  args: {
    blockNumber?: bigint;
    blockTimestamp?: bigint;
    source?: PoolUpdateSource;
  } = {},
): Promise<Pool> {
  return upsertPool({
    context,
    chainId: existing.chainId,
    poolId: existing.id,
    // Pass the SAME source the fixture already carries (by priority) so
    // `pickPreferredSource` is a no-op and `next.source` stays predictable.
    source: args.source ?? (existing.source as PoolUpdateSource),
    blockNumber: args.blockNumber ?? 10n,
    blockTimestamp: args.blockTimestamp ?? 1_700_000_100n,
    txHash: "0xabc",
    existing: { pool: existing },
  });
}

/** Assert every Pool field is byte-identical between `before` and `after`
 * except the explicitly-named changed fields (checked separately by each
 * test). Iterating `Object.keys` over the full fixture makes this
 * exhaustive: any future stage that starts touching an extra field fails
 * this assertion until the test is updated on purpose. */
function assertUnchangedExcept(
  before: Pool,
  after: Pool,
  changed: readonly (keyof Pool)[],
): void {
  const changedSet = new Set<keyof Pool>(changed);
  for (const key of Object.keys(before) as (keyof Pool)[]) {
    if (changedSet.has(key)) continue;
    assert.deepEqual(
      after[key],
      before[key],
      `expected Pool.${String(key)} to stay unchanged (before=${before[key]}, after=${after[key]})`,
    );
  }
}

describe("upsertPool heal-stage characterization (issue #1053 scenario 2)", () => {
  it("invert-heal stage: decodes a true readback and touches no other field", async () => {
    const existing = baselinePool({
      invertRateFeedKnown: false,
      invertRateFeed: false,
    });
    const { context } = makeContext(
      routedEffect([[invertRateFeedEffect, () => 1]]),
    );

    const result = await runUpsert(context, existing);

    assert.equal(result.invertRateFeed, true);
    assert.equal(result.invertRateFeedKnown, true);
    assertUnchangedExcept(existing, result, [
      "invertRateFeed",
      "invertRateFeedKnown",
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);
  });

  it("invert-heal stage: an RPC miss (-1 unknown sentinel) leaves the pool unhealed", async () => {
    const existing = baselinePool({
      invertRateFeedKnown: false,
      invertRateFeed: false,
    });
    const { context } = makeContext(
      routedEffect([[invertRateFeedEffect, () => -1]]),
    );

    const result = await runUpsert(context, existing);

    assert.equal(result.invertRateFeed, false);
    assert.equal(result.invertRateFeedKnown, false);
    assertUnchangedExcept(existing, result, [
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);
  });

  it("decimals-heal-on-null-effect stage: a partial RPC miss leaves BOTH decimals unset (no half-pinned state)", async () => {
    const existing = baselinePool({
      tokenDecimalsKnown: false,
      token0Decimals: 18,
      token1Decimals: 18,
    });
    const { context } = makeContext(
      routedEffect([
        [
          tokenDecimalsScalingEffect,
          (input: { fn: string }) =>
            input.fn === "decimals0" ? 10n ** 6n : null,
        ],
      ]),
    );

    const result = await runUpsert(context, existing);

    // Paired pinning: one succeeded (6dp) but the other RPC missed, so
    // neither decimal is persisted and `tokenDecimalsKnown` stays false —
    // the next event retries both.
    assert.equal(result.token0Decimals, 18);
    assert.equal(result.token1Decimals, 18);
    assert.equal(result.tokenDecimalsKnown, false);
    assertUnchangedExcept(existing, result, [
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);
  });

  it("decimals-heal stage: both RPC reads succeed, decimals land and tokenDecimalsKnown flips true", async () => {
    const existing = baselinePool({
      tokenDecimalsKnown: false,
      token0Decimals: 18,
      token1Decimals: 18,
    });
    const { context } = makeContext(
      routedEffect([
        [
          tokenDecimalsScalingEffect,
          (input: { fn: string }) =>
            input.fn === "decimals0" ? 10n ** 6n : 10n ** 18n,
        ],
      ]),
    );

    const result = await runUpsert(context, existing);

    assert.equal(result.token0Decimals, 6);
    assert.equal(result.token1Decimals, 18);
    assert.equal(result.tokenDecimalsKnown, true);
    assertUnchangedExcept(existing, result, [
      "token0Decimals",
      "tokenDecimalsKnown",
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);
  });

  it("fee-heal stage: -1 sentinels resolve to real fee values, independent of feed/breaker state", async () => {
    const existing = baselinePool({
      lpFee: -1,
      protocolFee: -1,
      rebalanceReward: -1,
    });
    const { context } = makeContext(
      routedEffect([
        [
          feesEffect,
          () => ({ lpFee: 25, protocolFee: 15, rebalanceReward: 3 }),
        ],
      ]),
    );

    const result = await runUpsert(context, existing);

    assert.equal(result.lpFee, 25);
    assert.equal(result.protocolFee, 15);
    assert.equal(result.rebalanceReward, 3);
    // Isolated: referenceRateFeedID was already assigned, so the coupled
    // feed/breaker-recompute gate never fires alongside this stage.
    assert.equal(result.referenceRateFeedID, existing.referenceRateFeedID);
    assert.equal(result.breakerTripped, existing.breakerTripped);
    assertUnchangedExcept(existing, result, [
      "lpFee",
      "protocolFee",
      "rebalanceReward",
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);
  });

  it("feed-heal + breaker-halt recompute stage: the '' -> assigned transition mirrors both together", async () => {
    // `upsertPool`'s feed self-heal and its breaker-halt recompute share the
    // same gate (`existing.referenceRateFeedID === ""`), so pinning one
    // without the other would misrepresent current behavior — a pool
    // getting its first feed assignment always re-evaluates halt state in
    // the same event.
    const existing = baselinePool({
      referenceRateFeedID: "",
      breakerTripped: false,
    });
    const { context } = makeContext(
      routedEffect([
        [referenceRateFeedIDEffect, () => FEED],
        [reportExpiryEffect, () => 3_600n],
      ]),
    );
    // The feed is already halted at assignment time.
    (
      context as unknown as {
        BreakerConfig: { getWhere: () => Promise<unknown[]> };
      }
    ).BreakerConfig.getWhere = async () => [
      {
        chainId: CHAIN_ID,
        rateFeedID: FEED,
        enabled: true,
        status: "TRIPPED",
        breaker_id: "b",
      },
    ];

    const result = await runUpsert(context, existing);

    assert.equal(result.referenceRateFeedID, FEED);
    assert.equal(result.oracleExpiry, 3_600n);
    assert.equal(result.breakerTripped, true);
    assertUnchangedExcept(existing, result, [
      "referenceRateFeedID",
      "oracleExpiry",
      "breakerTripped",
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);
  });

  it("wrapped-exchange-link heal stage: a VirtualPool mirrors feed/freshness/reporters and disables the FPMM-only stages", async () => {
    const vpAddress = "0x00000000000000000000000000000000000bee";
    const poolId = makePoolId(CHAIN_ID, vpAddress);
    const exchangeId = "0x" + "22".repeat(32);
    // VPs never get invert/fee/feed-and-breaker self-heal — pin that they
    // stay at their unhealed sentinels through this stage.
    const existing = baselinePool({
      id: poolId,
      source: "virtual_pool_factory",
      wrappedExchangeId: "",
      referenceRateFeedID: "",
      oracleFreshnessWindow: 0n,
      oracleNumReporters: -1,
      invertRateFeedKnown: false,
      invertRateFeed: false,
      lpFee: -1,
      protocolFee: -1,
      rebalanceReward: -1,
      breakerTripped: false,
    });
    const { context, writtenExchanges } = makeContext(
      routedEffect([
        [
          vpExchangeIdEffect,
          () => ({
            exchangeProvider: "0x00000000000000000000000000000000000cde",
            exchangeId,
          }),
        ],
        [
          poolExchangeEffect,
          () => ({
            asset0: existing.token0,
            asset1: existing.token1,
            pricingModule: CONSTANT_SUM_MAINNET,
            bucket0: 100n,
            bucket1: 100n,
            lastBucketUpdate: 1_699_999_500n,
            spread: 300n,
            referenceRateFeedID: FEED,
            referenceRateResetFrequency: 300n,
            minimumReports: 3n,
            stablePoolResetSize: 1_000n,
          }),
        ],
        [numReportersEffect, () => 5],
      ]),
    );

    const result = await runUpsert(context, existing);

    assert.equal(result.wrappedExchangeId, exchangeId);
    assert.equal(result.referenceRateFeedID, FEED);
    assert.equal(result.oracleFreshnessWindow, 300n);
    assert.equal(result.oracleNumReporters, 5);
    // FPMM-only stages stay untouched for a VP (isVirtualPool gate).
    assert.equal(result.invertRateFeedKnown, false);
    assert.equal(result.lpFee, -1);
    assert.equal(result.protocolFee, -1);
    assert.equal(result.rebalanceReward, -1);
    assert.equal(result.breakerTripped, false);
    assertUnchangedExcept(existing, result, [
      "wrappedExchangeId",
      "referenceRateFeedID",
      "oracleFreshnessWindow",
      "oracleNumReporters",
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);

    assert.equal(writtenExchanges.length, 1);
    const exchange = writtenExchanges[0]!;
    assert.equal(exchange.wrappedByPoolId, poolId);
    assert.equal(exchange.referenceRateFeedID, FEED);
    assert.equal(exchange.referenceRateResetFrequency, 300n);
  });

  it("all stages together: an FPMM whose factory-time RPC fan-out entirely failed heals every field in one event", async () => {
    const existing = baselinePool({
      invertRateFeedKnown: false,
      invertRateFeed: false,
      tokenDecimalsKnown: false,
      token0Decimals: 18,
      token1Decimals: 18,
      referenceRateFeedID: "",
      oracleNumReporters: -1,
      lpFee: -1,
      protocolFee: -1,
      rebalanceReward: -1,
      breakerTripped: false,
      wrappedExchangeId: "", // stays "" — bytecode probe below confirms non-VP
    });
    const { context } = makeContext(
      routedEffect([
        [invertRateFeedEffect, () => 1],
        [
          tokenDecimalsScalingEffect,
          (input: { fn: string }) =>
            input.fn === "decimals0" ? 10n ** 6n : 10n ** 18n,
        ],
        [referenceRateFeedIDEffect, () => FEED],
        [reportExpiryEffect, () => 7_200n],
        [
          feesEffect,
          () => ({ lpFee: 20, protocolFee: 10, rebalanceReward: 1 }),
        ],
        // Bytecode probe confirms "not a VP" — the wrapped-exchange stage
        // participates in the pipeline as a documented no-op.
        [vpExchangeIdEffect, () => null],
      ]),
    );

    const result = await runUpsert(context, existing);

    assert.equal(result.invertRateFeed, true);
    assert.equal(result.invertRateFeedKnown, true);
    assert.equal(result.token0Decimals, 6);
    assert.equal(result.token1Decimals, 18);
    assert.equal(result.tokenDecimalsKnown, true);
    assert.equal(result.referenceRateFeedID, FEED);
    assert.equal(result.oracleExpiry, 7_200n);
    assert.equal(result.lpFee, 20);
    assert.equal(result.protocolFee, 10);
    assert.equal(result.rebalanceReward, 1);
    assert.equal(result.breakerTripped, false); // feed's own breaker was OK
    assert.equal(result.wrappedExchangeId, ""); // confirmed non-VP, no-op
    assertUnchangedExcept(existing, result, [
      "invertRateFeed",
      "invertRateFeedKnown",
      "token0Decimals",
      "tokenDecimalsKnown",
      "referenceRateFeedID",
      "oracleExpiry",
      "lpFee",
      "protocolFee",
      "rebalanceReward",
      "updatedAtBlock",
      "updatedAtTimestamp",
    ]);
  });
});
