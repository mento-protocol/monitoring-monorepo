/// <reference types="mocha" />
import { assert } from "chai";
import {
  computeMedianLineageNext,
  computeOracleJumpBps,
  type MedianLineageState,
} from "../src/oracleJump";

// SortedOracles stores prices at 24dp; the helper works on raw values so we
// use 1e24 to represent "price = 1.0".
const ONE = 10n ** 24n;

const EMPTY_LINEAGE: MedianLineageState = {
  lastMedianPrice: 0n,
  lastMedianAt: 0n,
  prevMedianPrice: 0n,
  prevMedianAt: 0n,
  lastOracleJumpBps: "0.0000",
  lastOracleJumpAt: 0n,
  medianLive: false,
};

describe("computeOracleJumpBps", () => {
  it("returns null when no prior median (prevMedian == 0)", () => {
    assert.isNull(computeOracleJumpBps(0n, ONE));
  });

  it("returns null when new median is 0 (transient outage — don't record 100%-down)", () => {
    assert.isNull(computeOracleJumpBps(ONE, 0n));
  });

  it("returns '0.0000' for an unchanged median", () => {
    assert.equal(computeOracleJumpBps(ONE, ONE), "0.0000");
  });

  it("formats a 10 bps jump up as '10.0000'", () => {
    // +0.1% → 10 bps
    const next = ONE + ONE / 1000n;
    assert.equal(computeOracleJumpBps(ONE, next), "10.0000");
  });

  it("takes the absolute value — 10 bps DOWN renders as '10.0000'", () => {
    const next = ONE - ONE / 1000n;
    assert.equal(computeOracleJumpBps(ONE, next), "10.0000");
  });

  it("retains sub-bps precision ('0.5000' for a 0.5 bps jump)", () => {
    // +0.005% → 0.5 bps
    const next = ONE + ONE / 20000n;
    assert.equal(computeOracleJumpBps(ONE, next), "0.5000");
  });

  it("formats a 100 bps jump (1%) as '100.0000'", () => {
    const next = ONE + ONE / 100n;
    assert.equal(computeOracleJumpBps(ONE, next), "100.0000");
  });

  it("works with non-unit reference prices (EUR/USD around 1.08)", () => {
    // 1.08 → 1.0908 = +1%, so 100 bps
    const prev = (ONE * 108n) / 100n;
    const next = (ONE * 10908n) / 10000n;
    assert.equal(computeOracleJumpBps(prev, next), "100.0000");
  });

  it("handles the warning-tier example (10.5 bps on a 10 bps fee)", () => {
    // +0.105% = 10.5 bps = 105/100_000 of the reference price
    const next = ONE + (ONE * 105n) / 100_000n;
    assert.equal(computeOracleJumpBps(ONE, next), "10.5000");
  });

  it("handles the critical-tier boundary (exactly 11 bps = 10% above a 10 bps fee)", () => {
    // +0.11% = 11 bps = 110/100_000 of the reference price.
    // The terraform `Oracle Jump Far Above Swap Fee` rule uses `>= fee × 1.10`
    // so 11 bps on a 10 bps fee must route to critical. This asserts the helper
    // emits the exact boundary value the alert expression will compare against.
    const next = ONE + (ONE * 110n) / 100_000n;
    assert.equal(computeOracleJumpBps(ONE, next), "11.0000");
  });
});

describe("computeMedianLineageNext", () => {
  // Walks the same `0 → 1.00 → 1.12 → 0 → 1.15` sequence the Oracle Jump
  // alert depends on. Each it() is one MedianUpdated; state threads through.

  it("first non-zero median advances lastMedian* but leaves prev* / jump* at 0", () => {
    const next = computeMedianLineageNext(EMPTY_LINEAGE, ONE, 1_000n);
    assert.equal(next.lastMedianPrice, ONE);
    assert.equal(next.lastMedianAt, 1_000n);
    assert.equal(next.prevMedianPrice, 0n);
    assert.equal(next.prevMedianAt, 0n);
    assert.equal(next.lastOracleJumpBps, "0.0000");
    assert.equal(next.lastOracleJumpAt, 0n);
  });

  it("second non-zero median captures prior into prev* and records the jump", () => {
    const seeded: MedianLineageState = {
      ...EMPTY_LINEAGE,
      lastMedianPrice: ONE,
      lastMedianAt: 1_000n,
    };
    const newMedian = (ONE * 112n) / 100n;
    const next = computeMedianLineageNext(seeded, newMedian, 2_000n);
    assert.equal(next.lastMedianPrice, newMedian);
    assert.equal(next.lastMedianAt, 2_000n);
    assert.equal(next.prevMedianPrice, ONE);
    assert.equal(next.prevMedianAt, 1_000n);
    assert.equal(next.lastOracleJumpBps, "1200.0000");
    assert.equal(next.lastOracleJumpAt, 2_000n);
  });

  it("zero new median freezes price/timestamp fields and flips medianLive false (transient outage)", () => {
    const seeded: MedianLineageState = {
      lastMedianPrice: (ONE * 112n) / 100n,
      lastMedianAt: 2_000n,
      prevMedianPrice: ONE,
      prevMedianAt: 1_000n,
      lastOracleJumpBps: "1200.0000",
      lastOracleJumpAt: 2_000n,
      medianLive: true,
    };
    const next = computeMedianLineageNext(seeded, 0n, 3_000n);
    // Price + timestamp + jump fields freeze (transient outage). The new
    // `medianLive` flag flips to false so derive paths can detect that
    // the contract treats the feed as down even though `lastMedianPrice`
    // is preserved.
    assert.deepEqual(next, { ...seeded, medianLive: false });
  });

  it("post-outage non-zero median promotes the frozen lastMedian into prev*", () => {
    // Sequence at this point: 1.00 (T=1000) → 1.12 (T=2000) → 0 (frozen) →
    // 1.15 (T=4000). The 0 was a transient outage (no state change), so the
    // 1.15 update treats 1.12 as its "previous" and writes prevMedianAt =
    // 2000 (not the outage timestamp).
    const seededAfterOutage: MedianLineageState = {
      lastMedianPrice: (ONE * 112n) / 100n,
      lastMedianAt: 2_000n,
      prevMedianPrice: ONE,
      prevMedianAt: 1_000n,
      lastOracleJumpBps: "1200.0000",
      lastOracleJumpAt: 2_000n,
      medianLive: false,
    };
    const newMedian = (ONE * 115n) / 100n;
    const next = computeMedianLineageNext(seededAfterOutage, newMedian, 4_000n);
    assert.equal(next.lastMedianPrice, newMedian);
    assert.equal(next.lastMedianAt, 4_000n);
    assert.equal(next.prevMedianPrice, (ONE * 112n) / 100n);
    assert.equal(next.prevMedianAt, 2_000n);
    assert.equal(next.lastOracleJumpAt, 4_000n);
    // |1.15 - 1.12| / 1.12 × 10_000 ≈ 267.857… bps; the helper truncates
    // to 4dp so the exact emitted value is "267.8571".
    assert.equal(next.lastOracleJumpBps, "267.8571");
  });

  it("unchanged median emits a 0-bps jump and refreshes timestamps (no prev shift)", () => {
    // Republished median with the same value: counts as a transition (jumpBps
    // = '0.0000', not null), so prev* and jump* timestamps DO refresh — even
    // though the price didn't move. The Oracle Jump alert gates on jump_bps
    // > swap_fee_bps so this won't false-fire, but the lineage still advances.
    const seeded: MedianLineageState = {
      ...EMPTY_LINEAGE,
      lastMedianPrice: ONE,
      lastMedianAt: 1_000n,
    };
    const next = computeMedianLineageNext(seeded, ONE, 2_000n);
    assert.equal(next.lastMedianPrice, ONE);
    assert.equal(next.lastMedianAt, 2_000n);
    assert.equal(next.prevMedianPrice, ONE);
    assert.equal(next.prevMedianAt, 1_000n);
    assert.equal(next.lastOracleJumpBps, "0.0000");
    assert.equal(next.lastOracleJumpAt, 2_000n);
  });
});
