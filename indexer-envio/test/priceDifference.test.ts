/// <reference types="mocha" />
import { strict as assert } from "assert";
import { computePriceDifference } from "../src/EventHandlers";
import {
  buildRebalanceOutcome,
  computeEffectivenessRatio,
  tryDeriveRebalanceState,
} from "../src/priceDifference";

const SCALE = 10n ** 24n;

// Helper: build a pool input for computePriceDifference / tryDeriveRebalanceState.
// Threshold fields default to 100 (live, symmetric); oracle freshness fields
// default to "fresh and known" so the fixture is usable from either consumer
// without per-test setup. `lastMedianPrice` defaults to `oraclePrice` so
// derive sees a valid median; tests can override either independently to
// model contaminated `oraclePrice` (reporter quote) vs. clean median.
function pool(opts: {
  reserves0: bigint;
  reserves1: bigint;
  oraclePrice: bigint;
  invertRateFeed?: boolean;
  invertRateFeedKnown?: boolean;
  token0Decimals?: number;
  token1Decimals?: number;
  rebalanceThresholdAbove?: number;
  rebalanceThresholdBelow?: number;
  rebalanceThresholdsKnown?: boolean;
  lastMedianPrice?: bigint;
  lastMedianAt?: bigint;
  oracleOk?: boolean;
  oracleExpiry?: bigint;
}) {
  return {
    token0Decimals: 18,
    token1Decimals: 18,
    invertRateFeed: false,
    invertRateFeedKnown: true,
    rebalanceThresholdAbove: 100,
    rebalanceThresholdBelow: 100,
    rebalanceThresholdsKnown: true,
    lastMedianPrice: opts.oraclePrice,
    lastMedianAt: 1_000_000n,
    oracleOk: true,
    oracleExpiry: 3_600n,
    ...opts,
  };
}

const FRESH = { eventTimestamp: 1_000_500n };

describe("computePriceDifference", () => {
  // -----------------------------------------------------------------------
  // Contract-verified scenario: AUSD/USDm pool 0xb0a… on Monad mainnet
  // token0 = AUSD (6 decimals), token1 = USDm (18 decimals)
  // On-chain: reserves0=60001377664 (6dp), reserves1=40047366881133248737236 (18dp)
  // getRebalancingState() → priceDifference = 3325 bps
  // -----------------------------------------------------------------------

  const AUSD_USDM_ORACLE = 999_931_000_000_000_000_000_000n; // ≈ 0.999931 at 24dp
  // reserves0 = 60001377664 at 6dp → normalized to 18dp: × 10^12
  const AUSD_R0_RAW = 60_001_377_664n; // raw on-chain (6dp)
  // reserves1 already 18dp
  const AUSD_R1 = 40_047_366_881_133_248_737_236n;

  it("AUSD/USDm pool: correct 6dp decimals yields 3325 bps (matches contract)", () => {
    // With correct token0Decimals=6, normalizeTo18 scales reserves0 by 10^12,
    // giving ~60001 tokens. ratio = 40047/60001 ≈ 0.6674, oracle ≈ 0.99993.
    // deviation = |0.6674 - 0.99993| / 0.99993 ≈ 3325 bps.
    const pd = computePriceDifference(
      pool({
        reserves0: AUSD_R0_RAW,
        reserves1: AUSD_R1,
        oraclePrice: AUSD_USDM_ORACLE,
        token0Decimals: 6,
        token1Decimals: 18,
      }),
    );
    assert.equal(pd, 3325n, `expected 3325 bps (contract value), got ${pd}`);
  });

  it("AUSD/USDm pool: wrong 18dp decimals computes astronomical ratio", () => {
    // With wrong token0Decimals=18, reserves0=60001377664 normalizes to ~6e10
    // (no scaling), giving an enormous reserve ratio vs the oracle.
    // Without the dust guard, the actual computed deviation is returned.
    const pd = computePriceDifference(
      pool({
        reserves0: AUSD_R0_RAW,
        reserves1: AUSD_R1,
        oraclePrice: AUSD_USDM_ORACLE,
        token0Decimals: 18, // wrong — this is what the DB had before the fix
        token1Decimals: 18,
      }),
    );
    assert.equal(pd, 6674868461244722n, `expected astronomical bps, got ${pd}`);
  });

  // -----------------------------------------------------------------------
  // Contract-verified scenario: pool 0xb0a... on Monad (original test data)
  // getRebalancingState returns priceDifference = 3333 bps
  // reservePrice = reserve1 / reserve0 = 40017/60026 ≈ 0.6668, oracle ≈ 1.0
  // (CORRECTED: FPMM uses token1/token0 direction, so we swap the constants)
  // -----------------------------------------------------------------------

  const ORACLE_PRICE = 999_992_860_000_000_000_000_000n; // ≈ 1.0 at 24dp
  const R0 = 60_025_803_785_000_000_000_000n; // ~60k (18dp) — was R1_NON
  const R1 = 40_017_373_654_286_326_120_236n; // ~40k (18dp) — was R0_USDM

  it("non-inverted pool — matches contract priceDifference (3333 bps)", () => {
    // reserve1/reserve0 = 40017/60026 ≈ 0.6668, oracle ≈ 1.0
    // deviation = |0.6668 - 1.0| / 1.0 ≈ 33.33% ≈ 3333 bps
    const pd = computePriceDifference(
      pool({
        reserves0: R0,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
      }),
    );
    assert.equal(pd, 3333n);
  });

  it("invertRateFeed=true — inverts oracle, different result", () => {
    // With invertRateFeed, the contract compares reserve1/reserve0 against 1/oracle.
    // reserve1/reserve0 = 40017/60026 ≈ 0.6668, 1/oracle ≈ 1.0 (oracle ≈ 1.0)
    // deviation ≈ |0.6668 - 1.0| / 1.0 ≈ 33.3% ≈ 3333 bps (same because oracle ≈ 1.0)
    const pd = computePriceDifference(
      pool({
        reserves0: R0,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
        invertRateFeed: true,
      }),
    );
    // With oracle ≈ 1.0, inverting gives ≈ 1.0 — same deviation
    assert.equal(pd, 3333n);
  });

  // -----------------------------------------------------------------------
  // Mixed decimals: token0 = USDC (6dp), token1 = 18dp token
  // -----------------------------------------------------------------------

  it("mixed decimals: 6dp token0, 18dp token1", () => {
    // 60k at 6dp = 60_025_803_785, 40k at 18dp
    const pd = computePriceDifference(
      pool({
        reserves0: 60_025_803_785n,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
        token0Decimals: 6,
        token1Decimals: 18,
      }),
    );
    // reserve1/reserve0 = 40k/60k ≈ 0.667, oracle ≈ 1.0, deviation ≈ 33.3%
    assert.equal(pd, 3333n);
  });

  it("mixed decimals: 18dp token0, 6dp token1", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R1,
        reserves1: 60_025_803_785n,
        oraclePrice: ORACLE_PRICE,
        token0Decimals: 18,
        token1Decimals: 6,
      }),
    );
    // reserve1/reserve0 = 60k/40k = 1.5, oracle ≈ 1.0, deviation ≈ 50%
    assert.ok(pd >= 4990n && pd <= 5010n, `expected ~5000 bps, got ${pd}`);
  });

  // -----------------------------------------------------------------------
  // GBP/USD style: oracle ≈ 1.34, deviation ≈ 33.6%
  // -----------------------------------------------------------------------

  it("non-unity oracle (GBP/USD ≈ 1.34)", () => {
    const gbpOracle = 1_340_000_000_000_000_000_000_000n; // 1.34 at 24dp
    // reserve1/reserve0 = 890/1000 = 0.89, oracle = 1.34
    // deviation = |0.89 - 1.34| / 1.34 ≈ 33.58%
    const reserves0 = 1_000_000_000_000_000_000_000n; // 1.0 (18dp)
    const reserves1 = 890_000_000_000_000_000_000n; // 0.89 (18dp)

    const pd = computePriceDifference(
      pool({
        reserves0,
        reserves1,
        oraclePrice: gbpOracle,
      }),
    );

    assert.ok(pd >= 3350n && pd <= 3360n, `expected ~3358 bps, got ${pd}`);
  });

  it("invertRateFeed=true with non-unity oracle", () => {
    const gbpOracle = 1_340_000_000_000_000_000_000_000n; // 1.34 at 24dp
    // With invertRateFeed, effective oracle = 1/1.34 ≈ 0.7463
    // reserve1/reserve0 = 890/1000 = 0.89
    // deviation = |0.89 - 0.7463| / 0.7463 ≈ 19.26%
    const reserves0 = 1_000_000_000_000_000_000_000n;
    const reserves1 = 890_000_000_000_000_000_000n;

    const pd = computePriceDifference(
      pool({
        reserves0,
        reserves1,
        oraclePrice: gbpOracle,
        invertRateFeed: true,
      }),
    );

    assert.ok(pd >= 1920n && pd <= 1930n, `expected ~1926 bps, got ${pd}`);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("returns 0 when oracle price is 0", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: R0,
        reserves1: R1,
        oraclePrice: 0n,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("returns 0 when reserves are 0", () => {
    const pd = computePriceDifference(
      pool({
        reserves0: 0n,
        reserves1: R1,
        oraclePrice: ORACLE_PRICE,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("extreme imbalance: dust reserve1 below 1 token is computed normally", () => {
    // 1 wei of token1 vs 1e18 token0 — essentially drained pool.
    // Without the dust guard, the actual price deviation is returned.
    // reserveRatio = 1e6 (in SCALE units), oracle = 1.0 → deviation ≈ 9999 bps
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000n,
        reserves1: 1n,
        oraclePrice: SCALE, // oracle = 1.0
      }),
    );
    assert.equal(pd, 9999n, `expected 9999 bps, got ${pd}`);
  });

  it("extreme imbalance: reserve1 >= 1 token is computed normally", () => {
    // 1 full token (1e18) of token1 vs 1000 tokens of token0 — valid but imbalanced
    // reserve1/reserve0 = 1e18 / 1000e18 = 0.001, oracle = 1.0 → deviation ≈ 9990 bps
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000_000n, // 1000 tokens at 18dp
        reserves1: 1_000_000_000_000_000_000n, // 1 token at 18dp
        oraclePrice: SCALE, // oracle = 1.0
      }),
    );
    assert.ok(pd >= 9980n && pd <= 9999n, `expected ~9990 bps, got ${pd}`);
  });

  it("returns 0 when >18dp normalization floors reserves to zero", () => {
    // 1 wei at 24dp normalizes to 0 at 18dp — must not throw division by zero
    const pd = computePriceDifference(
      pool({
        reserves0: 1n,
        reserves1: 1_000_000_000_000_000_000n,
        oraclePrice: SCALE,
        token0Decimals: 24,
        token1Decimals: 18,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("balanced pool returns 0 deviation", () => {
    // reserves match oracle exactly: 1:1, oracle = 1.0
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000n,
        reserves1: 1_000_000_000_000_000_000n,
        oraclePrice: SCALE,
      }),
    );
    assert.equal(pd, 0n);
  });

  it("balanced pool with invertRateFeed=true returns 0 deviation", () => {
    // reserve1/reserve0 = 1.0, invertRateFeed oracle = 1/1.0 = 1.0
    const pd = computePriceDifference(
      pool({
        reserves0: 1_000_000_000_000_000_000n,
        reserves1: 1_000_000_000_000_000_000n,
        oraclePrice: SCALE,
        invertRateFeed: true,
      }),
    );
    assert.equal(pd, 0n);
  });
});

describe("computeEffectivenessRatio", () => {
  // Boundary-relative definition (2026-04-24 redefinition):
  //   effectiveness = (before - after) / (before - threshold)
  // 1.0 = rebalance exactly landed on threshold
  // >1.0 = overshoot past threshold (toward oracle or beyond)
  // <0 = rebalance made deviation worse
  // null = degenerate (before <= 0, threshold missing, or pool already in-band)

  it("lands exactly on boundary: after = threshold yields 1.0000", () => {
    // before=3333, threshold=3000, after=3000 → gap=333, improvement=333 → 1.0
    assert.equal(computeEffectivenessRatio(3333n, 3000n, 3000), "1.0000");
  });

  it("half correction toward boundary yields 0.5000", () => {
    // before=3333, threshold=3000, after=3166.5 (~), improvement ~166.5
    // gap=333 → 166.5/333 ≈ 0.5
    // Use exact ints: before=1333, threshold=1000 → gap=333; after=1166 → imp=167
    // 167/333 = 0.5015 → test with exact division: before=1200, threshold=1000,
    // gap=200, improvement=100, after=1100 → 0.5000
    assert.equal(computeEffectivenessRatio(1200n, 1100n, 1000), "0.5000");
  });

  it("over-corrects to oracle midpoint (old '100%' case) now reports > 1", () => {
    // before=3333, threshold=3000, after=0. Under OLD def this was 1.0.
    // Under NEW def: improvement=3333, gap=333 → 10.0090 — overshoot.
    const eff = computeEffectivenessRatio(3333n, 0n, 3000);
    assert.ok(eff != null && Number(eff) > 1.5, `expected >> 1, got ${eff}`);
  });

  it("no reduction: before == after yields 0.0000", () => {
    assert.equal(computeEffectivenessRatio(3333n, 3333n, 3000), "0.0000");
  });

  it("rebalance made it WORSE: after > before yields negative (alertable)", () => {
    // before=3333, threshold=3000, after=3500 → improvement=-167, gap=333
    // → -0.5015. Must publish — metrics-bridge sentinel-skip only filters
    // the exact string "-1", so negative non-sentinel values reach Prometheus.
    const eff = computeEffectivenessRatio(3333n, 3500n, 3000);
    assert.ok(eff != null && Number(eff) < 0, `expected negative, got ${eff}`);
  });

  it("degenerate: before = 0 returns null", () => {
    assert.equal(computeEffectivenessRatio(0n, 0n, 3000), null);
  });

  it("degenerate: before < 0 (impossible in practice) returns null", () => {
    assert.equal(computeEffectivenessRatio(-100n, 50n, 3000), null);
  });

  it("degenerate: threshold = 0 sentinel returns null", () => {
    // Indexer hasn't read the on-chain threshold yet — no meaningful boundary.
    assert.equal(computeEffectivenessRatio(3333n, 100n, 0), null);
  });

  it("degenerate: before <= threshold (pool was already in-band) returns null", () => {
    // Rebalancer fired for a pool that wasn't actually over threshold. There's
    // no gap-to-boundary to close; effectiveness isn't defined here.
    assert.equal(computeEffectivenessRatio(2500n, 2000n, 3000), null);
  });

  it("degenerate: before == threshold exactly returns null", () => {
    // Zero gap → avoid division-by-zero.
    assert.equal(computeEffectivenessRatio(3000n, 2900n, 3000), null);
  });
});

describe("buildRebalanceOutcome — sentinel rendering", () => {
  it("degenerate rebalance: `eventEffectivenessRatio` is empty string, not '0.0000'", () => {
    // Pool already in-band (before <= threshold) — no meaningful "gap closed".
    // The event sentinel MUST be distinct from a real 0% effective rebalance
    // so the dashboard can render degenerate as `—` without hiding real misses.
    const out = buildRebalanceOutcome({
      priceDifferenceBefore: 2500n,
      priceDifferenceAfter: 2200n,
      rebalanceThreshold: 3000,
    });
    assert.equal(out.eventEffectivenessRatio, "");
    assert.equal(out.lastEffectivenessRatio, "-1");
  });

  it("genuine 0% effective (before == after above threshold): '0.0000', NOT the sentinel", () => {
    const out = buildRebalanceOutcome({
      priceDifferenceBefore: 3333n,
      priceDifferenceAfter: 3333n,
      rebalanceThreshold: 3000,
    });
    assert.equal(out.eventEffectivenessRatio, "0.0000");
    assert.equal(out.lastEffectivenessRatio, "0.0000");
  });

  it("real rebalance: sentinel paths not triggered", () => {
    const out = buildRebalanceOutcome({
      priceDifferenceBefore: 3333n,
      priceDifferenceAfter: 3000n,
      rebalanceThreshold: 3000,
    });
    assert.equal(out.eventEffectivenessRatio, "1.0000");
    assert.equal(out.lastEffectivenessRatio, "1.0000");
    assert.equal(out.improvement, 333n);
  });
});

describe("tryDeriveRebalanceState", () => {
  // Reuses the AUSD/USDm contract-verified scenario above so the derived
  // priceDifference is anchored to the on-chain expected value.
  const ORACLE = 999_931_000_000_000_000_000_000n;
  const R0 = 60_001_377_664n; // 6dp
  const R1 = 40_047_366_881_133_248_737_236n; // 18dp

  // AUSD/USDm fixture wrapped over the file-level `pool()` helper.
  const ausdPool = (opts?: Partial<Parameters<typeof pool>[0]>) =>
    pool({
      reserves0: R0,
      reserves1: R1,
      oraclePrice: ORACLE,
      token0Decimals: 6,
      token1Decimals: 18,
      ...opts,
    });

  it("returns null when lastMedianPrice is 0 (pre-MedianUpdated)", () => {
    assert.equal(
      tryDeriveRebalanceState(ausdPool({ lastMedianPrice: 0n }), FRESH),
      null,
    );
  });

  it("returns null when rebalanceThresholdsKnown is false", () => {
    assert.equal(
      tryDeriveRebalanceState(
        ausdPool({ rebalanceThresholdsKnown: false }),
        FRESH,
      ),
      null,
    );
  });

  it("derives when known 0/0 thresholds (legitimate 'never rebalance')", () => {
    // Schema-level invariant: `rebalanceThresholdsKnown=true` + 0/0 means
    // governance configured the pool to never rebalance. Derive should
    // succeed, not fall back to RPC.
    const derived = tryDeriveRebalanceState(
      ausdPool({ rebalanceThresholdAbove: 0, rebalanceThresholdBelow: 0 }),
      FRESH,
    );
    assert.ok(derived != null, "known 0/0 should still derive");
    assert.equal(derived.rebalanceThreshold, 0);
  });

  it("returns null when oracleOk is false", () => {
    assert.equal(
      tryDeriveRebalanceState(ausdPool({ oracleOk: false }), FRESH),
      null,
    );
  });

  it("returns null when median is stale (lastMedianAt + expiry <= eventTimestamp)", () => {
    // lastMedianAt 1_000_000n + expiry 3_600n = 1_003_600n.
    // eventTimestamp 1_003_700n is past the expiry → contract reverts.
    assert.equal(
      tryDeriveRebalanceState(ausdPool(), { eventTimestamp: 1_003_700n }),
      null,
    );
  });

  it("returns null when oracleExpiry is 0 (unseeded window — fall through to RPC)", () => {
    // Without a known expiry the freshness gate can't be evaluated. Falling
    // through to RPC is safer than letting a potentially-expired median
    // through (cf. codex G10 — once a cached median is reused, no later
    // fallback can save us).
    assert.equal(
      tryDeriveRebalanceState(ausdPool({ oracleExpiry: 0n }), FRESH),
      null,
    );
  });

  it("returns null when invertRateFeedKnown is false (unseeded direction flag)", () => {
    // Caller runs `selfHealInvertRateFeed` first, so reaching derive with
    // `Known=false` means the heal also failed. Inverted pools would compute
    // priceDifference / threshold direction in the wrong frame — fall through
    // to RPC, which still supplies a correct priceDifference even when the
    // local flip is unknown.
    assert.equal(
      tryDeriveRebalanceState(ausdPool({ invertRateFeedKnown: false }), FRESH),
      null,
    );
  });

  it("returns null during a zero-median outage even when lastMedianPrice retained the prior value", () => {
    // `MedianUpdated` with value 0 keeps lastMedianPrice at the prior
    // non-zero value (per computeMedianLineageNext), but oraclePrice goes
    // to 0. The contract treats the feed as down — derive must mirror.
    assert.equal(
      tryDeriveRebalanceState(ausdPool({ oraclePrice: 0n }), FRESH),
      null,
    );
  });

  it("staleness uses lastMedianAt only (cursor's stale-oracle finding)", () => {
    // Confirm the gate evaluates against `lastMedianAt`, not against any
    // other "last touched at" timestamp. Old lastMedianAt + recent event →
    // stale.
    assert.equal(
      tryDeriveRebalanceState(ausdPool({ lastMedianAt: 0n }), {
        eventTimestamp: 1_000_500n,
      }),
      null,
      "lastMedianAt=0 + expiry=3600 → expiresAt=3600 which is before event 1_000_500 → stale",
    );
  });

  it("derives priceDifference matching computePriceDifference (3325 bps)", () => {
    const derived = tryDeriveRebalanceState(ausdPool(), FRESH);
    assert.ok(derived != null, "expected non-null derive result");
    assert.equal(derived.priceDifference, 3325n);
    assert.equal(derived.oraclePrice, ORACLE);
  });

  it("uses lastMedianPrice (not oraclePrice) for the math", () => {
    // OracleReported overwrites pool.oraclePrice with reporter quote;
    // contract's getRebalancingState uses median. Derive must follow contract.
    // Pass a contaminated oraclePrice (very different from median) and
    // verify the result tracks lastMedianPrice.
    const derived = tryDeriveRebalanceState(
      ausdPool({
        oraclePrice: 5n * 10n ** 24n, // contaminated (5×) — should be ignored
        lastMedianPrice: ORACLE,
      }),
      FRESH,
    );
    assert.equal(derived?.priceDifference, 3325n);
    assert.equal(derived?.oraclePrice, ORACLE);
  });

  it("picks `below` threshold when reservePrice <= median", () => {
    // AUSD/USDm: reservePrice (norm1/norm0) ≈ 0.667 < median 0.999931 → below.
    const derived = tryDeriveRebalanceState(
      ausdPool({ rebalanceThresholdAbove: 50, rebalanceThresholdBelow: 200 }),
      FRESH,
    );
    assert.equal(derived?.rebalanceThreshold, 200);
  });

  it("picks `above` threshold when reservePrice > median", () => {
    const derived = tryDeriveRebalanceState(
      ausdPool({
        reserves1: R1 * 10n,
        rebalanceThresholdAbove: 50,
        rebalanceThresholdBelow: 200,
      }),
      FRESH,
    );
    assert.equal(derived?.rebalanceThreshold, 50);
  });

  it("invertRateFeed flag flips the direction comparison", () => {
    // reserveRatio = SCALE, lastMedianPrice = 2*SCALE.
    // un-inverted: 1 < 2 -> below. inverted: oracleRef = 0.5, 1 > 0.5 -> above.
    const flipOpts = {
      reserves0: 1_000n * 10n ** 18n,
      reserves1: 1_000n * 10n ** 18n,
      oraclePrice: 2n * 10n ** 24n,
      rebalanceThresholdAbove: 50,
      rebalanceThresholdBelow: 200,
    };
    const noInv = tryDeriveRebalanceState(pool(flipOpts), FRESH);
    const inv = tryDeriveRebalanceState(
      pool({ ...flipOpts, invertRateFeed: true }),
      FRESH,
    );
    assert.equal(noInv?.rebalanceThreshold, 200, "below side un-inverted");
    assert.equal(inv?.rebalanceThreshold, 50, "above side after invert");
  });

  it("uses reservesOverride when caller passes pre-write reserves (UpdateReserves path)", () => {
    const derived = tryDeriveRebalanceState(
      ausdPool({ reserves0: 1n, reserves1: 1n }),
      {
        eventTimestamp: 1_000_500n,
        reservesOverride: { reserve0: R0, reserve1: R1 },
      },
    );
    assert.ok(derived != null);
    assert.equal(derived.priceDifference, 3325n);
  });

  it("returns 0 priceDifference when reserves are 0 (degenerate pool)", () => {
    const derived = tryDeriveRebalanceState(
      ausdPool({ reserves0: 0n, reserves1: 0n }),
      FRESH,
    );
    assert.ok(derived != null);
    assert.equal(derived.priceDifference, 0n);
  });

  it("works with only one of the two thresholds set (asymmetric governance)", () => {
    const derived = tryDeriveRebalanceState(
      ausdPool({ rebalanceThresholdAbove: 0, rebalanceThresholdBelow: 150 }),
      FRESH,
    );
    assert.equal(derived?.rebalanceThreshold, 150);
  });
});
