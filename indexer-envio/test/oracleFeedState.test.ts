import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  applyOracleFeedExpiry,
  applyOracleReport,
  applyOracleReportRemoval,
  bootstrapOracleFeedState,
  upperMedianTimestamp,
} from "../src/oracleFeedState.js";

const CHAIN_ID = 42220;
const FEED = "0xF4F9bbDA9cd6841fCB9B1510F9269E2db42A6E3A";
const REPORTER_A = "0x00000000000000000000000000000000000000Aa";
const REPORTER_B = "0x00000000000000000000000000000000000000bB";
const REPORTER_C = "0x00000000000000000000000000000000000000Cc";
const REPORTER_D = "0x00000000000000000000000000000000000000dD";

function bootstrap(
  reporters: readonly string[] = [REPORTER_A, REPORTER_B, REPORTER_C],
  timestamps: readonly bigint[] = [10n, 20n, 30n],
) {
  return bootstrapOracleFeedState({
    chainId: CHAIN_ID,
    rateFeedID: FEED,
    reporters,
    timestamps,
    reportExpiry: 300n,
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

describe("upperMedianTimestamp", () => {
  it.each([
    { timestamps: [] as bigint[], expected: 0n, label: "empty" },
    { timestamps: [7n], expected: 7n, label: "one report" },
    { timestamps: [1n, 9n], expected: 9n, label: "two reports" },
    { timestamps: [9n, 1n, 5n], expected: 5n, label: "three reports" },
    {
      timestamps: [9n, 1n, 7n, 3n],
      expected: 7n,
      label: "four reports",
    },
    {
      timestamps: [9n, 5n, 1n, 5n],
      expected: 5n,
      label: "tied middle reports",
    },
  ])(
    "returns the contract upper median for $label",
    ({ timestamps, expected }) => {
      assert.equal(upperMedianTimestamp(timestamps), expected);
    },
  );

  it("does not mutate the caller's timestamp array", () => {
    const timestamps = [30n, 10n, 20n];
    assert.equal(upperMedianTimestamp(timestamps), 20n);
    assert.deepEqual(timestamps, [30n, 10n, 20n]);
  });
});

describe("bootstrapOracleFeedState", () => {
  it("canonicalizes reporter order while preserving address-to-timestamp alignment", () => {
    const state = bootstrap(
      [REPORTER_C, REPORTER_A, REPORTER_B],
      [30n, 10n, 20n],
    );

    assert.equal(state.id, `${CHAIN_ID}-${FEED.toLowerCase()}`);
    assert.equal(state.rateFeedID, FEED.toLowerCase());
    assert.deepEqual(state.activeReporters, [
      REPORTER_A.toLowerCase(),
      REPORTER_B.toLowerCase(),
      REPORTER_C.toLowerCase(),
    ]);
    assert.deepEqual(state.activeReportTimestamps, [10n, 20n, 30n]);
    assert.equal(state.medianReportTimestamp, 20n);
    assert.equal(state.updatedAtBlock, 100n);
    assert.equal(state.updatedAtLogIndex, -1);
  });

  it("produces identical canonical state from different input order and casing", () => {
    const first = bootstrap(
      [REPORTER_C, REPORTER_A, REPORTER_B],
      [30n, 10n, 20n],
    );
    const second = bootstrap(
      [REPORTER_B.toLowerCase(), REPORTER_C.toLowerCase(), REPORTER_A],
      [20n, 30n, 10n],
    );

    assert.deepEqual(first, second);
  });

  it("rejects malformed bootstrap state", () => {
    assert.throws(
      () => bootstrap([REPORTER_A], [10n, 20n]),
      /bootstrap length mismatch/,
    );
    assert.throws(
      () => bootstrap([REPORTER_A, REPORTER_A.toLowerCase()], [10n, 20n]),
      /duplicate reporter/,
    );
    assert.throws(
      () => bootstrap([REPORTER_A], [0n]),
      /non-positive timestamp/,
    );
    assert.throws(
      () =>
        bootstrapOracleFeedState({
          chainId: CHAIN_ID,
          rateFeedID: FEED,
          reporters: [],
          timestamps: [],
          reportExpiry: 0n,
          bootstrapThroughBlock: 100n,
        }),
      /invalid expiry/,
    );
  });
});

describe("applyOracleReport", () => {
  it("replaces an existing reporter timestamp and recomputes the upper median", () => {
    const initial = bootstrap();
    const next = applyOracleReport(initial, REPORTER_A, 40n, event(101n, 2));

    assert.deepEqual(next.activeReporters, initial.activeReporters);
    assert.deepEqual(next.activeReportTimestamps, [40n, 20n, 30n]);
    assert.equal(next.medianReportTimestamp, 30n);
    assert.equal(next.updatedAtBlock, 101n);
    assert.equal(next.updatedAtLogIndex, 2);
    assert.equal(next.updatedAtTimestamp, 1_010n);
  });

  it("inserts a new reporter in canonical order with its timestamp aligned", () => {
    const next = applyOracleReport(
      bootstrap([REPORTER_A, REPORTER_C], [10n, 30n]),
      REPORTER_B,
      20n,
      event(101n, 1),
    );

    assert.deepEqual(next.activeReporters, [
      REPORTER_A.toLowerCase(),
      REPORTER_B.toLowerCase(),
      REPORTER_C.toLowerCase(),
    ]);
    assert.deepEqual(next.activeReportTimestamps, [10n, 20n, 30n]);
    assert.equal(next.medianReportTimestamp, 20n);
  });

  it("is idempotent for the same event position", () => {
    const initial = bootstrap();
    const applied = applyOracleReport(initial, REPORTER_A, 40n, event(101n, 2));
    const replayed = applyOracleReport(
      applied,
      REPORTER_A,
      40n,
      event(101n, 2),
    );

    assert.strictEqual(replayed, applied);
    assert.throws(
      () => applyOracleReport(applied, REPORTER_A, 999n, event(101n, 2)),
      /conflicts at persisted event position/,
    );
  });

  it("rejects reports at or behind the persisted event cursor", () => {
    const initial = bootstrap();
    assert.throws(
      () => applyOracleReport(initial, REPORTER_A, 40n, event(100n, 0)),
      /OracleReported is out of order/,
    );

    const applied = applyOracleReport(initial, REPORTER_A, 40n, event(101n, 5));
    assert.throws(
      () => applyOracleReport(applied, REPORTER_B, 50n, event(101n, 4)),
      /OracleReported is out of order/,
    );
    assert.throws(
      () => applyOracleReport(applied, REPORTER_B, 50n, event(100n, 9)),
      /OracleReported is out of order/,
    );
  });
});

describe("applyOracleReportRemoval", () => {
  it("removes the reporter and recomputes the upper median", () => {
    const next = applyOracleReportRemoval(
      bootstrap(
        [REPORTER_A, REPORTER_B, REPORTER_C, REPORTER_D],
        [10n, 20n, 30n, 40n],
      ),
      REPORTER_C,
      event(101n, 3),
    );

    assert.deepEqual(next.activeReporters, [
      REPORTER_A.toLowerCase(),
      REPORTER_B.toLowerCase(),
      REPORTER_D.toLowerCase(),
    ]);
    assert.deepEqual(next.activeReportTimestamps, [10n, 20n, 40n]);
    assert.equal(next.medianReportTimestamp, 20n);
  });

  it("returns a zero median after the last active report is removed", () => {
    const next = applyOracleReportRemoval(
      bootstrap([REPORTER_A], [10n]),
      REPORTER_A,
      event(101n, 1),
    );

    assert.deepEqual(next.activeReporters, []);
    assert.deepEqual(next.activeReportTimestamps, []);
    assert.equal(next.medianReportTimestamp, 0n);
  });

  it("rejects a missing reporter and out-of-order removals", () => {
    const initial = bootstrap();
    assert.throws(
      () => applyOracleReportRemoval(initial, REPORTER_D, event(101n, 1)),
      /reporter missing/,
    );
    assert.throws(
      () => applyOracleReportRemoval(initial, REPORTER_A, event(100n, 0)),
      /OracleReportRemoved is out of order/,
    );

    const applied = applyOracleReportRemoval(
      initial,
      REPORTER_A,
      event(101n, 5),
    );
    assert.throws(
      () => applyOracleReportRemoval(applied, REPORTER_B, event(101n, 4)),
      /OracleReportRemoved is out of order/,
    );
  });
});

describe("applyOracleFeedExpiry", () => {
  it("updates expiry and the event cursor without changing report state", () => {
    const initial = bootstrap();
    const next = applyOracleFeedExpiry(initial, 31_536_000n, event(101n, 7));

    assert.equal(next.reportExpiry, 31_536_000n);
    assert.equal(next.updatedAtBlock, 101n);
    assert.equal(next.updatedAtLogIndex, 7);
    assert.equal(next.updatedAtTimestamp, 1_010n);
    assert.deepEqual(next.activeReporters, initial.activeReporters);
    assert.deepEqual(
      next.activeReportTimestamps,
      initial.activeReportTimestamps,
    );
    assert.equal(next.medianReportTimestamp, initial.medianReportTimestamp);
    assert.equal(next.bootstrapThroughBlock, initial.bootstrapThroughBlock);
  });

  it("ignores non-positive and duplicate-position expiry updates", () => {
    const initial = bootstrap();
    assert.strictEqual(
      applyOracleFeedExpiry(initial, 0n, event(101n, 1)),
      initial,
    );

    const applied = applyOracleFeedExpiry(initial, 600n, event(101n, 2));
    assert.strictEqual(
      applyOracleFeedExpiry(applied, 600n, event(101n, 2)),
      applied,
    );
    assert.throws(
      () => applyOracleFeedExpiry(applied, 900n, event(101n, 2)),
      /conflicts at persisted event position/,
    );
  });

  it("rejects an out-of-order expiry update", () => {
    const applied = applyOracleFeedExpiry(bootstrap(), 600n, event(101n, 5));

    assert.throws(
      () => applyOracleFeedExpiry(applied, 900n, event(101n, 4)),
      /oracle expiry update is out of order/,
    );
  });
});
