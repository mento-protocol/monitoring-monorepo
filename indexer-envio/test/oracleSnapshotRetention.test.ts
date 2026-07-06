import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  computeRawSnapshotCutoff,
  shouldPersistRawOracleSnapshot,
  shouldPersistRawOracleSnapshotAt,
} from "../src/oracleSnapshotRetention.js";

describe("OracleSnapshot raw retention", () => {
  it("disables the cutoff when retention is unset", () => {
    assert.equal(computeRawSnapshotCutoff(1_700_000_000, undefined), null);
    assert.equal(shouldPersistRawOracleSnapshot(0n), true);
  });

  it("computes the cutoff in whole days", () => {
    assert.equal(computeRawSnapshotCutoff(1_700_000_000, 90), 1_692_224_000n);
  });

  it("persists boundary timestamps and skips older timestamps", () => {
    const cutoff = computeRawSnapshotCutoff(1_700_000_000, 90);
    assert.ok(cutoff !== null);

    assert.equal(
      shouldPersistRawOracleSnapshotAt(cutoff, 1_700_000_000, 90),
      true,
    );
    assert.equal(
      shouldPersistRawOracleSnapshotAt(cutoff - 1n, 1_700_000_000, 90),
      false,
    );
  });

  it("evaluates the cutoff from the current call time", () => {
    const firstCutoff = computeRawSnapshotCutoff(1_700_000_000, 90);
    assert.ok(firstCutoff !== null);
    const blockTimestamp = firstCutoff + 10n;

    assert.equal(
      shouldPersistRawOracleSnapshotAt(blockTimestamp, 1_700_000_000, 90),
      true,
    );
    assert.equal(
      shouldPersistRawOracleSnapshotAt(blockTimestamp, 1_700_000_020, 90),
      false,
    );
  });
});
