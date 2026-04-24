/// <reference types="mocha" />
import { assert } from "chai";
import { computeOracleJumpBps } from "../src/oracleJump";

// SortedOracles stores prices at 24dp; the helper works on raw values so we
// use 1e24 to represent "price = 1.0".
const ONE = 10n ** 24n;

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

  it("handles the alert-boundary example (10.5 bps on a 10 bps fee)", () => {
    // +0.105% = 10.5 bps = 105/100_000 of the reference price
    const next = ONE + (ONE * 105n) / 100_000n;
    assert.equal(computeOracleJumpBps(ONE, next), "10.5000");
  });
});
