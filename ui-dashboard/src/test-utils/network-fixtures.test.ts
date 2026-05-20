import { describe, expect, it } from "vitest";
import { buildSnapshotWindows } from "@/lib/volume";
import { makeNetworkData, TEST_NOW } from "@/test-utils/network-fixtures";

describe("network fixtures", () => {
  it("uses a deterministic default snapshot window anchor", () => {
    expect(makeNetworkData().snapshotWindows).toEqual(
      buildSnapshotWindows(TEST_NOW),
    );
  });

  it("allows callers to override snapshot windows", () => {
    const snapshotWindows = buildSnapshotWindows(Date.UTC(2026, 4, 20));
    expect(makeNetworkData({ snapshotWindows }).snapshotWindows).toBe(
      snapshotWindows,
    );
  });
});
