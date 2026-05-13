import { assert } from "vitest";
import type { Pool } from "envio";
import {
  breachEntryThreshold,
  isInDeviationBreach,
  maybePreloadPool,
  nextDeviationBreachStartedAt,
  nextOpenBreachEntryThreshold,
} from "../src/pool";
import { makePool } from "./helpers/makePool";

describe("isInDeviationBreach", () => {
  it("false when priceDifference is well below threshold", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 4999n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("false at exact threshold (devRatio = 1.0, inside tolerance)", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 5000n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("false inside the 1% tolerance dead zone (devRatio = 1.005)", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 5025n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("false at exactly the tolerance line — strict `>` (devRatio = 1.01)", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 5050n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("true just above the tolerance line (devRatio = 1.012)", () => {
    assert.isTrue(
      isInDeviationBreach(
        makePool({ priceDifference: 5060n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("true on a large breach (devRatio = 1.5)", () => {
    assert.isTrue(
      isInDeviationBreach(
        makePool({ priceDifference: 7500n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("false for virtual pools regardless of deviation", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({
          source: "virtual_pool_factory",
          priceDifference: 10_000n,
          rebalanceThreshold: 5000,
        }),
      ),
    );
  });

  it("falls back to threshold=10000 when rebalanceThreshold === 0; tolerance applies on top", () => {
    // 10_100 = at tolerance boundary (1.01x of 10_000 fallback) — not a breach.
    // 10_101 = just above tolerance (1.0101x of 10_000 fallback) — a breach.
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 10_000n, rebalanceThreshold: 0 }),
      ),
    );
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 10_100n, rebalanceThreshold: 0 }),
      ),
    );
    assert.isTrue(
      isInDeviationBreach(
        makePool({ priceDifference: 10_101n, rebalanceThreshold: 0 }),
      ),
    );
  });
});

describe("nextDeviationBreachStartedAt", () => {
  const TS = 1_700_000_000n;

  it("OK → CRITICAL sets to blockTimestamp", () => {
    const prev = makePool({ priceDifference: 1000n });
    const next = makePool({ priceDifference: 6000n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), TS);
  });

  it("CRITICAL → CRITICAL preserves original startedAt", () => {
    const origStart = 1_600_000_000n;
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: origStart,
    });
    const next = makePool({ priceDifference: 7500n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), origStart);
  });

  it("breached → close-to-threshold (still under) resets to 0n", () => {
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: 1_600_000_000n,
    });
    const next = makePool({ priceDifference: 4500n }); // d = 0.9 → OK
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), 0n);
  });

  it("breached → well under threshold resets to 0n", () => {
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: 1_600_000_000n,
    });
    const next = makePool({ priceDifference: 1000n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), 0n);
  });

  it("under-threshold → breached sets the anchor", () => {
    const prev = makePool({
      priceDifference: 4500n,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({ priceDifference: 5100n }); // breached
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), TS);
  });

  it("oracle-stale does NOT clear an active deviation breach", () => {
    // isInDeviationBreach is intentionally price-only. A pool that is in breach
    // should keep its start timestamp even if the oracle goes stale.
    const origStart = 1_600_000_000n;
    const prev = makePool({
      oracleOk: true,
      priceDifference: 6000n,
      deviationBreachStartedAt: origStart,
    });
    const next = makePool({
      oracleOk: false, // oracle went stale
      priceDifference: 6000n, // still breached
    });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), origStart);
  });

  it("self-heals when prev is breached but deviationBreachStartedAt === 0n", () => {
    // Partial restore / pre-backfill scenario: a row lands with
    // priceDifference >= threshold but deviationBreachStartedAt = 0n. Instead
    // of preserving the bad sentinel forever, adopt the current block time.
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({ priceDifference: 6500n });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), TS);
  });

  it("first event (prev undefined) already breached sets to blockTimestamp", () => {
    const next = makePool({ priceDifference: 6000n });
    assert.equal(nextDeviationBreachStartedAt(undefined, next, TS), TS);
  });

  it("first event (prev undefined) not breached stays 0n", () => {
    const next = makePool({ priceDifference: 1000n });
    assert.equal(nextDeviationBreachStartedAt(undefined, next, TS), 0n);
  });

  it("re-entry CRITICAL → OK → CRITICAL starts a fresh timestamp", () => {
    const firstStart = 1_600_000_000n;

    // In breach
    const s1 = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: firstStart,
    });
    // Exit to OK
    const s2 = makePool({ priceDifference: 1000n });
    const afterExit = nextDeviationBreachStartedAt(s1, s2, TS);
    assert.equal(afterExit, 0n);

    // Re-enter at later timestamp
    const s2Updated = { ...s2, deviationBreachStartedAt: afterExit };
    const s3 = makePool({ priceDifference: 7500n });
    const TS2 = TS + 3600n;
    const afterReentry = nextDeviationBreachStartedAt(s2Updated, s3, TS2);
    assert.equal(afterReentry, TS2);
    assert.notEqual(afterReentry, firstStart);
  });

  it("virtual pools always stay at 0n", () => {
    const prev = makePool({ source: "virtual_pool_factory" });
    const next = makePool({
      source: "virtual_pool_factory",
      priceDifference: 10_000n,
    });
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), 0n);
  });

  it("holds the anchor on a falling edge when source is 'fpmm_update_reserves'", () => {
    // FPMM emits ReservesUpdated inside swap/rebalance/mint/burn. If
    // UpdateReserves was allowed to close the anchor, the semantic
    // handler firing right after would see `prev.anchor = 0n` and skip
    // — the breach row would be stuck with `endedByEvent = undefined`.
    // Holding the anchor lets the next handler in the same tx close it
    // with the correct attribution.
    const origStart = 1_600_000_000n;
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: origStart,
    });
    const next = makePool({
      priceDifference: 2000n, // reserves rebalance pushed price below threshold
    });
    assert.equal(
      nextDeviationBreachStartedAt(prev, next, TS, "fpmm_update_reserves"),
      origStart,
    );
  });

  it("keeps holding the anchor across consecutive UpdateReserves in the same tx", () => {
    // Real scenario: FPMM emits ReservesUpdated TWICE inside a single
    // rebalance tx — once with the partial state, once with the final.
    // UR#1 already pulled priceDifference BELOW threshold, so UR#2 sees
    // a prev where `isInDeviationBreach(prev)` is false. The deferral
    // MUST consult the anchor, not the price, or UR#2 would close the
    // breach as "unknown" before the Rebalanced handler gets a chance.
    //
    // `prev.priceDifference` is deliberately UNDER threshold — makes
    // `wasBreachedPrice = false`. Only `wasBreachedAnchor = true` keeps
    // the deferral active. A regression that swaps the two variables
    // (or re-introduces a price-based check) fails this test.
    const origStart = 1_600_000_000n;
    const prev = makePool({
      priceDifference: 3000n, // well below threshold — UR#1 already healed price
      rebalanceThreshold: 3333,
      deviationBreachStartedAt: origStart, // anchor still held by UR#1
    });
    const next = makePool({
      priceDifference: 3000n, // still below — UR#2 is post-state confirmation
      rebalanceThreshold: 3333,
    });
    assert.equal(
      nextDeviationBreachStartedAt(prev, next, TS, "fpmm_update_reserves"),
      origStart,
    );
  });

  it("still closes the anchor on a falling edge when source is anything else", () => {
    // The deferral is scoped narrowly to UpdateReserves; a direct
    // Rebalance / Swap / oracle close must flip the anchor as normal.
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: 1_600_000_000n,
    });
    const next = makePool({ priceDifference: 2000n });
    assert.equal(
      nextDeviationBreachStartedAt(prev, next, TS, "fpmm_rebalanced"),
      0n,
    );
    assert.equal(
      nextDeviationBreachStartedAt(prev, next, TS, "oracle_reported"),
      0n,
    );
    // Omitted source (legacy callers) must also close normally.
    assert.equal(nextDeviationBreachStartedAt(prev, next, TS), 0n);
  });
});

// ---------------------------------------------------------------------------
// maybePreloadPool — preload-phase entity-cache warm-up
// ---------------------------------------------------------------------------

type CtxCalls = {
  poolGets: string[];
  breachGets: string[];
};

function makeCtx(isPreload: boolean, pools: Record<string, Pool | undefined>) {
  const calls: CtxCalls = { poolGets: [], breachGets: [] };
  return {
    calls,
    context: {
      isPreload,
      Pool: {
        get: async (id: string) => {
          calls.poolGets.push(id);
          return pools[id];
        },
      },
      DeviationThresholdBreach: {
        get: async (id: string) => {
          calls.breachGets.push(id);
          return undefined;
        },
      },
    },
  };
}

describe("maybePreloadPool", () => {
  it("returns false and touches nothing when not in preload phase", async () => {
    const { context, calls } = makeCtx(false, {});
    const result = await maybePreloadPool(context, "42220-0xabc");
    assert.isFalse(result);
    assert.deepEqual(calls.poolGets, []);
    assert.deepEqual(calls.breachGets, []);
  });

  it("preloads Pool only when pool is missing (no anchor to warm)", async () => {
    const { context, calls } = makeCtx(true, { "42220-0xabc": undefined });
    const result = await maybePreloadPool(context, "42220-0xabc");
    assert.isTrue(result);
    assert.deepEqual(calls.poolGets, ["42220-0xabc"]);
    assert.deepEqual(calls.breachGets, []);
  });

  it("preloads Pool only when pool exists but has no open breach anchor", async () => {
    const pool = makePool({ deviationBreachStartedAt: 0n });
    const id = pool.id;
    const { context, calls } = makeCtx(true, { [id]: pool });
    const result = await maybePreloadPool(context, id);
    assert.isTrue(result);
    assert.deepEqual(calls.poolGets, [id]);
    assert.deepEqual(calls.breachGets, []);
  });

  it("preloads both Pool AND the open breach row (correct `{poolId}-{anchor}` id) when an anchor is set", async () => {
    const anchor = 1_700_000_000n;
    const pool = makePool({ deviationBreachStartedAt: anchor });
    const id = pool.id;
    const { context, calls } = makeCtx(true, { [id]: pool });
    const result = await maybePreloadPool(context, id);
    assert.isTrue(result);
    assert.deepEqual(calls.poolGets, [id]);
    assert.deepEqual(calls.breachGets, [`${id}-${anchor}`]);
  });

  it("accepts an array of poolIds — oracle handlers preload many pools at once", async () => {
    const poolA = makePool({ deviationBreachStartedAt: 1_700_000_000n });
    const poolB = makePool({ deviationBreachStartedAt: 0n });
    // Distinct poolIds so the preload warms each independently.
    const aId = "42220-0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bId = "42220-0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { context, calls } = makeCtx(true, {
      [aId]: { ...poolA, id: aId },
      [bId]: { ...poolB, id: bId },
    });
    const result = await maybePreloadPool(context, [aId, bId]);
    assert.isTrue(result);
    assert.sameMembers(calls.poolGets, [aId, bId]);
    // Only poolA has an open anchor → only its breach row is warmed.
    assert.deepEqual(calls.breachGets, [
      `${aId}-${poolA.deviationBreachStartedAt}`,
    ]);
  });

  it("handles an empty array of poolIds cleanly (no-op in preload)", async () => {
    const { context, calls } = makeCtx(true, {});
    const result = await maybePreloadPool(context, []);
    assert.isTrue(result);
    assert.deepEqual(calls.poolGets, []);
    assert.deepEqual(calls.breachGets, []);
  });
});

// ---------------------------------------------------------------------------
// nextOpenBreachEntryThreshold (Pool denorm) — PR 1.6
// codex P2 #3214513401: matches the entity-row capture in
// `recordBreachTransition`. Asymmetric pools on their zero-threshold side
// score the breach predicate against the 10000 effective fallback; the
// denorm must store 10000 (not raw 0), and a continuing-breach event
// must NEVER overwrite a captured value, even when reserves flip to the
// active side.
// ---------------------------------------------------------------------------

describe("breachEntryThreshold — predicate-aligned entry capture (PR 1.6)", () => {
  it("returns the active threshold when positive (symmetric or on-active-side)", () => {
    assert.equal(breachEntryThreshold({ rebalanceThreshold: 5000 }), 5000);
  });

  it("returns 10000 fallback for asymmetric pool on its zero-threshold side", () => {
    // above=0, below=300, reserves picking the above side → active=0.
    // Predicate scored against effectiveThreshold = 10000 (asymmetric
    // case is NOT never-rebalance because below>0).
    assert.equal(
      breachEntryThreshold({
        rebalanceThreshold: 0,
        rebalanceThresholdAbove: 0,
        rebalanceThresholdBelow: 300,
        rebalanceThresholdsKnown: true,
      }),
      10000,
    );
  });

  it("returns 10000 fallback for asymmetric pool on its zero-threshold side (mirror: above=300, below=0)", () => {
    // Mirror case — reserves picking the below side → active=0 even though
    // above is positive. Same effectiveThreshold = 10000 logic; pin the
    // symmetry so a one-sided refactor can't regress half the asymmetric
    // pools (claude[bot] PR #370 review).
    assert.equal(
      breachEntryThreshold({
        rebalanceThreshold: 0,
        rebalanceThresholdAbove: 300,
        rebalanceThresholdBelow: 0,
        rebalanceThresholdsKnown: true,
      }),
      10000,
    );
  });

  it("returns 10000 fallback for unknown-zero (cold-start)", () => {
    // Known=false: indexer hasn't read on-chain. Predicate falls back
    // to 10000-bps under-bound; capture must match.
    assert.equal(
      breachEntryThreshold({
        rebalanceThreshold: 0,
        rebalanceThresholdsKnown: false,
      }),
      10000,
    );
  });

  it("returns 0 for never-rebalance (defensive — unreachable in practice)", () => {
    // BOTH split sides 0 + Known. `isInDeviationBreach` short-circuits
    // never-rebalance pools to false, so this code path shouldn't run.
    // If it does, return 0 instead of the 1e12 cushion that would
    // overflow `Int!`.
    assert.equal(
      breachEntryThreshold({
        rebalanceThreshold: 0,
        rebalanceThresholdAbove: 0,
        rebalanceThresholdBelow: 0,
        rebalanceThresholdsKnown: true,
      }),
      0,
    );
  });
});

describe("nextOpenBreachEntryThreshold — asymmetric pool capture (PR 1.6)", () => {
  it("returns 0 when no open breach", () => {
    const next = makePool({ deviationBreachStartedAt: 0n });
    assert.equal(nextOpenBreachEntryThreshold(undefined, next), 0);
  });

  it("rising edge captures persistableThreshold (10000 fallback) for asymmetric-zero-side breach", () => {
    const prev = makePool({
      priceDifference: 4000n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({
      priceDifference: 12_000n,
      rebalanceThreshold: 0, // active side picks 0
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 1_704_672_000n,
    });
    // Predicate scores against 10000 fallback (see effectiveThreshold).
    // The denorm must mirror that — not raw next.rebalanceThreshold = 0.
    assert.equal(nextOpenBreachEntryThreshold(prev, next), 10000);
  });

  it("rising edge captures the active threshold for symmetric pools", () => {
    const prev = makePool({
      priceDifference: 4000n,
      rebalanceThreshold: 5000,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({
      priceDifference: 8000n,
      rebalanceThreshold: 5000,
      deviationBreachStartedAt: 1_704_672_000n,
    });
    assert.equal(nextOpenBreachEntryThreshold(prev, next), 5000);
  });

  it("continuing breach holds the captured value even when reserves flip to the active side", () => {
    // Pre-fix: stored=0 (raw asymmetric capture) → heal swapped it to
    // post-flip 300, re-scoring history. Post-fix: stored=10000 (correct
    // capture), continuing event MUST NOT overwrite. Pin against the
    // post-flip pool state.
    const prev = makePool({
      priceDifference: 12_000n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 1_704_672_000n,
      currentOpenBreachEntryThreshold: 10000, // captured at rising edge
    });
    const next = makePool({
      priceDifference: 12_500n,
      rebalanceThreshold: 300, // <-- side flipped
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 1_704_672_000n,
    });
    assert.equal(nextOpenBreachEntryThreshold(prev, next), 10000);
  });

  it("legacy continuing breach with stored=0 stays at 0 (heal retired)", () => {
    // Old rows captured stored=0 raw. Pre-fix the heal would substitute
    // next.rebalanceThreshold once it became positive — re-scoring the
    // breach against the post-flip side. Post-fix: stored=0 stays 0;
    // closing fallback chain handles the floor.
    const prev = makePool({
      priceDifference: 12_000n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 1_704_672_000n,
      currentOpenBreachEntryThreshold: 0, // legacy capture
    });
    const next = makePool({
      priceDifference: 12_500n,
      rebalanceThreshold: 300,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 1_704_672_000n,
    });
    assert.equal(
      nextOpenBreachEntryThreshold(prev, next),
      0,
      "legacy stored=0 must NOT heal to next.rebalanceThreshold (PR 1.6)",
    );
  });
});
