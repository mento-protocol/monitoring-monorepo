/// <reference types="mocha" />
import { assert } from "chai";
import { isInDeviationBreach, nextDeviationBreachStartedAt } from "../src/pool";
import { makePool } from "./helpers/makePool";

describe("isInDeviationBreach", () => {
  it("false when priceDifference < threshold", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 4999n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("false at exact threshold (strict >; exactly-at-threshold stays OK per computeHealthStatus)", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 5000n, rebalanceThreshold: 5000 }),
      ),
    );
  });

  it("true when priceDifference > threshold", () => {
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

  it("falls back to threshold=10000 when rebalanceThreshold === 0", () => {
    assert.isFalse(
      isInDeviationBreach(
        makePool({ priceDifference: 10_000n, rebalanceThreshold: 0 }),
      ),
    );
    assert.isTrue(
      isInDeviationBreach(
        makePool({ priceDifference: 10_001n, rebalanceThreshold: 0 }),
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
    // UR#1 already pulled priceDifference to threshold, so UR#2 sees a
    // prev where `isInDeviationBreach(prev)` is false. We must still
    // hold the anchor (anchor-based check) or UR#2 would close the
    // breach as "unknown" before the Rebalanced handler gets a chance.
    const origStart = 1_600_000_000n;
    const prev = makePool({
      priceDifference: 3333n, // already at-threshold after UR#1
      rebalanceThreshold: 3333,
      deviationBreachStartedAt: origStart, // anchor still held by UR#1
    });
    const next = makePool({
      priceDifference: 3333n, // no movement — UR#2 is just the post-state confirmation
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
