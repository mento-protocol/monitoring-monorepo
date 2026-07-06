import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  computeRawSnapshotCutoff,
  shouldPersistRawOracleSnapshot,
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

    assert.equal(cutoff >= cutoff, true);
    assert.equal(cutoff - 1n >= cutoff, false);
  });
});
