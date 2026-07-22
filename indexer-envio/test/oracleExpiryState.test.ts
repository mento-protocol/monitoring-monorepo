import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  applyGlobalReportExpiry,
  applyTokenReportExpiry,
  bootstrapOracleExpiryState,
  oracleExpiryStateId,
} from "../src/oracleExpiryState.js";

const CHAIN_ID = 42220;
const FEED = "0xF4F9bbDA9cd6841fCB9B1510F9269E2db42A6E3A";

function bootstrap(globalReportExpiry = 300n, tokenReportExpiry = 900n) {
  return bootstrapOracleExpiryState({
    chainId: CHAIN_ID,
    rateFeedID: FEED,
    globalReportExpiry,
    tokenReportExpiry,
    bootstrapThroughBlock: 100n,
  });
}

function event(blockNumber: bigint, logIndex: number) {
  return {
    blockNumber,
    logIndex,
    blockTimestamp: blockNumber * 10n,
  };
}

describe("bootstrapOracleExpiryState", () => {
  it("canonicalizes the ID and initializes the event cursor", () => {
    const state = bootstrap();

    assert.equal(
      oracleExpiryStateId(CHAIN_ID, FEED),
      `${CHAIN_ID}-${FEED.toLowerCase()}`,
    );
    assert.equal(state.id, `${CHAIN_ID}-${FEED.toLowerCase()}`);
    assert.equal(state.rateFeedID, FEED.toLowerCase());
    assert.equal(state.chainId, CHAIN_ID);
    assert.equal(state.globalReportExpiry, 300n);
    assert.equal(state.tokenReportExpiry, 900n);
    assert.equal(state.reportExpiry, 900n);
    assert.equal(state.bootstrapThroughBlock, 100n);
    assert.equal(state.updatedAtBlock, 100n);
    assert.equal(state.updatedAtLogIndex, -1);
    assert.equal(state.updatedAtTimestamp, 0n);
  });

  it("uses the global expiry when the token override is zero", () => {
    const state = bootstrap(300n, 0n);

    assert.equal(state.tokenReportExpiry, 0n);
    assert.equal(state.reportExpiry, 300n);
  });

  it("rejects invalid raw expiry values", () => {
    assert.throws(() => bootstrap(0n), /invalid global expiry=0/);
    assert.throws(() => bootstrap(-1n), /invalid global expiry=-1/);
    assert.throws(() => bootstrap(300n, -1n), /invalid token expiry=-1/);
  });
});

describe("applyTokenReportExpiry", () => {
  it("sets and clears the token override while updating the cursor", () => {
    const initial = bootstrap(300n, 0n);
    const overridden = applyTokenReportExpiry(
      initial,
      31_536_000n,
      event(101n, 2),
    );

    assert.equal(overridden.globalReportExpiry, 300n);
    assert.equal(overridden.tokenReportExpiry, 31_536_000n);
    assert.equal(overridden.reportExpiry, 31_536_000n);
    assert.equal(overridden.updatedAtBlock, 101n);
    assert.equal(overridden.updatedAtLogIndex, 2);
    assert.equal(overridden.updatedAtTimestamp, 1_010n);

    const cleared = applyTokenReportExpiry(overridden, 0n, event(102n, 4));
    assert.equal(cleared.tokenReportExpiry, 0n);
    assert.equal(cleared.reportExpiry, 300n);
  });

  it("is idempotent only when raw and effective expiry both match", () => {
    const applied = applyTokenReportExpiry(
      bootstrap(300n, 0n),
      900n,
      event(101n, 2),
    );

    assert.strictEqual(
      applyTokenReportExpiry(applied, 900n, event(101n, 2)),
      applied,
    );
    assert.throws(
      () => applyTokenReportExpiry(applied, 600n, event(101n, 2)),
      /conflicts at persisted event position/,
    );
    assert.throws(
      () =>
        applyTokenReportExpiry(
          { ...applied, reportExpiry: 600n },
          900n,
          event(101n, 2),
        ),
      /conflicts at persisted event position/,
    );
  });

  it("rejects invalid, out-of-order, and absorbed-boundary events", () => {
    const initial = bootstrap();
    assert.throws(
      () => applyTokenReportExpiry(initial, -1n, event(101n, 1)),
      /invalid token expiry=-1/,
    );
    assert.throws(
      () => applyTokenReportExpiry(initial, 0n, event(100n, 0)),
      /at or behind bootstrap boundary/,
    );
    assert.throws(
      () => applyTokenReportExpiry(initial, 0n, event(99n, 99)),
      /at or behind bootstrap boundary/,
    );

    const applied = applyTokenReportExpiry(initial, 600n, event(101n, 5));
    assert.throws(
      () => applyTokenReportExpiry(applied, 0n, event(101n, 4)),
      /out of order/,
    );
  });
});

describe("applyGlobalReportExpiry", () => {
  it("updates the effective expiry only when no token override is active", () => {
    const fallbackState = applyGlobalReportExpiry(
      bootstrap(300n, 0n),
      600n,
      event(101n, 3),
    );
    assert.equal(fallbackState.globalReportExpiry, 600n);
    assert.equal(fallbackState.reportExpiry, 600n);
    assert.equal(fallbackState.updatedAtTimestamp, 1_010n);

    const overriddenState = applyGlobalReportExpiry(
      bootstrap(300n, 900n),
      600n,
      event(101n, 3),
    );
    assert.equal(overriddenState.globalReportExpiry, 600n);
    assert.equal(overriddenState.tokenReportExpiry, 900n);
    assert.equal(overriddenState.reportExpiry, 900n);
  });

  it("handles a same-block token clear followed by a global update", () => {
    const cleared = applyTokenReportExpiry(
      bootstrap(300n, 900n),
      0n,
      event(101n, 2),
    );
    const updated = applyGlobalReportExpiry(cleared, 600n, event(101n, 3));

    assert.equal(updated.tokenReportExpiry, 0n);
    assert.equal(updated.globalReportExpiry, 600n);
    assert.equal(updated.reportExpiry, 600n);
    assert.equal(updated.updatedAtLogIndex, 3);
  });

  it("handles a same-block global update followed by a token clear", () => {
    const globalUpdated = applyGlobalReportExpiry(
      bootstrap(300n, 900n),
      600n,
      event(101n, 2),
    );
    assert.equal(globalUpdated.reportExpiry, 900n);

    const cleared = applyTokenReportExpiry(globalUpdated, 0n, event(101n, 3));
    assert.equal(cleared.tokenReportExpiry, 0n);
    assert.equal(cleared.globalReportExpiry, 600n);
    assert.equal(cleared.reportExpiry, 600n);
    assert.equal(cleared.updatedAtLogIndex, 3);
  });

  it("is idempotent only when raw and effective expiry both match", () => {
    const applied = applyGlobalReportExpiry(
      bootstrap(300n, 0n),
      600n,
      event(101n, 2),
    );

    assert.strictEqual(
      applyGlobalReportExpiry(applied, 600n, event(101n, 2)),
      applied,
    );
    assert.throws(
      () => applyGlobalReportExpiry(applied, 900n, event(101n, 2)),
      /conflicts at persisted event position/,
    );
    assert.throws(
      () =>
        applyGlobalReportExpiry(
          { ...applied, reportExpiry: 900n },
          600n,
          event(101n, 2),
        ),
      /conflicts at persisted event position/,
    );
  });

  it("rejects invalid, out-of-order, and absorbed-boundary events", () => {
    const initial = bootstrap();
    assert.throws(
      () => applyGlobalReportExpiry(initial, 0n, event(101n, 1)),
      /invalid global expiry=0/,
    );
    assert.throws(
      () => applyGlobalReportExpiry(initial, -1n, event(101n, 1)),
      /invalid global expiry=-1/,
    );
    assert.throws(
      () => applyGlobalReportExpiry(initial, 600n, event(100n, 0)),
      /at or behind bootstrap boundary/,
    );

    const applied = applyGlobalReportExpiry(initial, 600n, event(101n, 5));
    assert.throws(
      () => applyGlobalReportExpiry(applied, 900n, event(101n, 4)),
      /out of order/,
    );
  });
});
