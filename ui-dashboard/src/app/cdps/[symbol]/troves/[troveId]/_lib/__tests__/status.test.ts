import { describe, expect, it } from "vitest";
import {
  TROVE_STATUSES,
  troveStatusBadgeClasses,
  troveStatusLabel,
  troveStatusTooltip,
} from "../status";

describe("trove status vocabulary", () => {
  it("has all five indexer statuses (troves.ts:16-22)", () => {
    expect(TROVE_STATUSES).toEqual([
      "active",
      "zombie",
      "closed",
      "liquidated",
      "redeemed",
    ]);
  });

  it.each(TROVE_STATUSES)(
    "has a non-empty label, tooltip, and badge class for %s",
    (status) => {
      expect(troveStatusLabel(status).length).toBeGreaterThan(0);
      expect(troveStatusTooltip(status)?.length ?? 0).toBeGreaterThan(0);
      expect(troveStatusBadgeClasses(status).length).toBeGreaterThan(0);
    },
  );

  it("explains zombie and redeemed with the design doc's own language", () => {
    expect(troveStatusTooltip("zombie")).toContain(
      "unredeemable until adjusted",
    );
    expect(troveStatusTooltip("redeemed")).toContain("Fully redeemed to zero");
  });

  it("degrades gracefully for an unknown status (defensive, schema drift)", () => {
    expect(troveStatusLabel("unknown-future-status")).toBe(
      "unknown-future-status",
    );
    expect(troveStatusTooltip("unknown-future-status")).toBeNull();
    expect(troveStatusBadgeClasses("unknown-future-status")).toContain("slate");
  });
});
